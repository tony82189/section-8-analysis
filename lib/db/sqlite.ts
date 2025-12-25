import Database from 'better-sqlite3';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Job, JobType, JobStatus, Run, RunStatus, Artifact, ArtifactType, Property, Analysis } from '../types';

// Database path - stored in project data directory
const DB_PATH = path.join(process.cwd(), 'data', 'section8.db');

let db: Database.Database | null = null;

/**
 * Get or create the SQLite database connection
 */
export function getDatabase(): Database.Database {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        initializeSchema(db);
    }
    return db;
}

/**
 * Initialize the database schema
 */
function initializeSchema(database: Database.Database): void {
    database.exec(`
    -- Runs table
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT,
      file_size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      dry_run INTEGER NOT NULL DEFAULT 0,
      current_step TEXT,
      progress REAL DEFAULT 0,
      total_pages INTEGER,
      chunks_created INTEGER,
      properties_extracted INTEGER,
      properties_filtered INTEGER,
      properties_deduped INTEGER,
      properties_unavailable INTEGER,
      properties_analyzed INTEGER,
      top_n_count INTEGER,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_file_hash ON runs(file_hash);

    -- Jobs table (job queue)
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      payload TEXT NOT NULL,
      result TEXT,
      error TEXT,
      attempts INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3,
      run_at TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
    CREATE INDEX IF NOT EXISTS idx_jobs_run_at ON jobs(run_at);

    -- Property cache for dedup
    CREATE TABLE IF NOT EXISTS property_cache (
      id TEXT PRIMARY KEY,
      address_normalized TEXT,
      zillow_url_normalized TEXT,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_property_cache_address ON property_cache(address_normalized);
    CREATE INDEX IF NOT EXISTS idx_property_cache_zillow ON property_cache(zillow_url_normalized);

    -- Artifacts table
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      metadata TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts(run_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);

    -- Properties table (local cache)
    CREATE TABLE IF NOT EXISTS properties (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_properties_run_id ON properties(run_id);

    -- Analysis table (local cache)
    CREATE TABLE IF NOT EXISTS analysis (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (property_id) REFERENCES properties(id),
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_run_id ON analysis(run_id);
    CREATE INDEX IF NOT EXISTS idx_analysis_property_id ON analysis(property_id);

    -- Settings table
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

// ============================================================================
// Run Operations
// ============================================================================

export function createRun(data: {
    id?: string;
    fileHash: string;
    fileName: string;
    filePath?: string;
    fileSize: number;
    dryRun?: boolean;
}): Run {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = data.id || uuidv4();

    const stmt = db.prepare(`
    INSERT INTO runs (id, file_hash, file_name, file_path, file_size, dry_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

    stmt.run(id, data.fileHash, data.fileName, data.filePath || null, data.fileSize, data.dryRun ? 1 : 0, now);

    return getRun(id)!;
}

export function getRun(id: string): Run | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return mapRunRow(row);
}

export function updateRun(id: string, updates: Partial<Run>): Run | null {
    const db = getDatabase();
    const allowedFields = [
        'status', 'current_step', 'progress', 'total_pages', 'chunks_created',
        'properties_extracted', 'properties_filtered', 'properties_deduped',
        'properties_unavailable', 'properties_analyzed', 'top_n_count', 'error', 'started_at', 'completed_at'
    ];

    const fieldMap: Record<string, string> = {
        status: 'status',
        currentStep: 'current_step',
        progress: 'progress',
        totalPages: 'total_pages',
        chunksCreated: 'chunks_created',
        propertiesExtracted: 'properties_extracted',
        propertiesFiltered: 'properties_filtered',
        propertiesDeduped: 'properties_deduped',
        propertiesUnavailable: 'properties_unavailable',
        propertiesAnalyzed: 'properties_analyzed',
        topNCount: 'top_n_count',
        error: 'error',
        startedAt: 'started_at',
        completedAt: 'completed_at',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
        const dbField = fieldMap[key];
        if (dbField && allowedFields.includes(dbField)) {
            setClauses.push(`${dbField} = ?`);
            values.push(value);
        }
    }

    if (setClauses.length === 0) return getRun(id);

    values.push(id);

    const stmt = db.prepare(`
    UPDATE runs SET ${setClauses.join(', ')} WHERE id = ?
  `);

    stmt.run(...values);

    return getRun(id);
}

export function listRuns(options: { limit?: number; offset?: number; status?: RunStatus } = {}): Run[] {
    const db = getDatabase();
    const { limit = 50, offset = 0, status } = options;

    let query = 'SELECT * FROM runs';
    const params: unknown[] = [];

    if (status) {
        query += ' WHERE status = ?';
        params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(mapRunRow);
}

export function deleteRun(id: string): boolean {
    const db = getDatabase();

    // Check if run exists
    const run = getRun(id);
    if (!run) return false;

    // Delete in order of foreign key dependencies
    db.prepare('DELETE FROM analysis WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM properties WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM artifacts WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM property_cache WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM runs WHERE id = ?').run(id);

    return true;
}

export function deleteAllRuns(): { deletedCount: number; runIds: string[] } {
    const db = getDatabase();

    // Get all run IDs first (for file cleanup)
    const runs = db.prepare('SELECT id FROM runs').all() as { id: string }[];
    const runIds = runs.map(r => r.id);

    if (runIds.length === 0) {
        return { deletedCount: 0, runIds: [] };
    }

    // Delete all data in order of foreign key dependencies
    db.prepare('DELETE FROM analysis').run();
    db.prepare('DELETE FROM properties').run();
    db.prepare('DELETE FROM artifacts').run();
    db.prepare('DELETE FROM property_cache').run();
    db.prepare('DELETE FROM runs').run();

    return { deletedCount: runIds.length, runIds };
}

export function clearPropertiesForRun(runId: string): { deletedCount: number } {
    const db = getDatabase();

    // Check if run exists
    const run = getRun(runId);
    if (!run) {
        return { deletedCount: 0 };
    }

    // Delete analysis records first (foreign key dependency)
    db.prepare('DELETE FROM analysis WHERE run_id = ?').run(runId);

    // Delete properties and get count
    const result = db.prepare('DELETE FROM properties WHERE run_id = ?').run(runId);

    // Clear property cache for this run
    db.prepare('DELETE FROM property_cache WHERE run_id = ?').run(runId);

    // Reset run counters and status to allow re-extraction
    db.prepare(`
        UPDATE runs SET
            properties_extracted = NULL,
            properties_filtered = NULL,
            properties_deduped = NULL,
            properties_unavailable = NULL,
            properties_analyzed = NULL,
            top_n_count = NULL,
            status = 'pending',
            current_step = NULL,
            progress = 0,
            error = NULL,
            started_at = NULL,
            completed_at = NULL
        WHERE id = ?
    `).run(runId);

    return { deletedCount: result.changes };
}

function mapRunRow(row: Record<string, unknown>): Run {
    return {
        id: row.id as string,
        fileHash: row.file_hash as string,
        fileName: row.file_name as string,
        filePath: row.file_path as string | null,
        fileSize: row.file_size as number,
        status: row.status as RunStatus,
        dryRun: Boolean(row.dry_run),
        currentStep: row.current_step as string | null,
        progress: row.progress as number,
        totalPages: row.total_pages as number | null,
        chunksCreated: row.chunks_created as number | null,
        propertiesExtracted: row.properties_extracted as number | null,
        propertiesFiltered: row.properties_filtered as number | null,
        propertiesDeduped: row.properties_deduped as number | null,
        propertiesUnavailable: row.properties_unavailable as number | null,
        propertiesAnalyzed: row.properties_analyzed as number | null,
        topNCount: row.top_n_count as number | null,
        error: row.error as string | null,
        createdAt: row.created_at as string,
        startedAt: row.started_at as string | null,
        completedAt: row.completed_at as string | null,
    };
}

// ============================================================================
// Job Operations
// ============================================================================

export function createJob(data: {
    type: JobType;
    payload: Record<string, unknown>;
    priority?: number;
    maxAttempts?: number;
    runAt?: string;
}): Job {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuidv4();

    const stmt = db.prepare(`
    INSERT INTO jobs (id, type, payload, priority, max_attempts, run_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);

    stmt.run(
        id,
        data.type,
        JSON.stringify(data.payload),
        data.priority || 0,
        data.maxAttempts || 3,
        data.runAt || null,
        now
    );

    return getJob(id)!;
}

export function getJob(id: string): Job | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return mapJobRow(row);
}

export function getNextJob(types?: JobType[]): Job | null {
    const db = getDatabase();

    let query = `
    SELECT * FROM jobs 
    WHERE status = 'pending' 
    AND (run_at IS NULL OR run_at <= datetime('now'))
  `;

    const params: unknown[] = [];

    if (types && types.length > 0) {
        query += ` AND type IN (${types.map(() => '?').join(', ')})`;
        params.push(...types);
    }

    query += ' ORDER BY priority DESC, created_at ASC LIMIT 1';

    const row = db.prepare(query).get(...params) as Record<string, unknown> | undefined;

    if (!row) return null;

    // Mark as running
    const job = mapJobRow(row);
    updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() });

    return getJob(job.id);
}

export function updateJob(id: string, updates: Partial<Job>): Job | null {
    const db = getDatabase();
    const fieldMap: Record<string, string> = {
        status: 'status',
        result: 'result',
        error: 'error',
        attempts: 'attempts',
        startedAt: 'started_at',
        completedAt: 'completed_at',
    };

    const setClauses: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
        const dbField = fieldMap[key];
        if (dbField) {
            setClauses.push(`${dbField} = ?`);
            if (key === 'result' && typeof value === 'object') {
                values.push(JSON.stringify(value));
            } else {
                values.push(value);
            }
        }
    }

    if (setClauses.length === 0) return getJob(id);

    values.push(id);

    const stmt = db.prepare(`
    UPDATE jobs SET ${setClauses.join(', ')} WHERE id = ?
  `);

    stmt.run(...values);

    return getJob(id);
}

export function completeJob(id: string, result?: Record<string, unknown>): Job | null {
    return updateJob(id, {
        status: 'completed',
        result: result || null,
        completedAt: new Date().toISOString(),
    });
}

export function failJob(id: string, error: string): Job | null {
    const job = getJob(id);
    if (!job) return null;

    const newAttempts = job.attempts + 1;
    const shouldRetry = newAttempts < job.maxAttempts;

    return updateJob(id, {
        status: shouldRetry ? 'pending' : 'failed',
        error,
        attempts: newAttempts,
        completedAt: shouldRetry ? null : new Date().toISOString(),
    } as Partial<Job>);
}

function mapJobRow(row: Record<string, unknown>): Job {
    return {
        id: row.id as string,
        type: row.type as JobType,
        status: row.status as JobStatus,
        priority: row.priority as number,
        payload: JSON.parse(row.payload as string),
        result: row.result ? JSON.parse(row.result as string) : null,
        error: row.error as string | null,
        attempts: row.attempts as number,
        maxAttempts: row.max_attempts as number,
        runAt: row.run_at as string | null,
        createdAt: row.created_at as string,
        startedAt: row.started_at as string | null,
        completedAt: row.completed_at as string | null,
    };
}

// ============================================================================
// Artifact Operations
// ============================================================================

export function createArtifact(data: {
    runId: string;
    type: ArtifactType;
    path: string;
    metadata?: Record<string, unknown>;
}): Artifact {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuidv4();

    const stmt = db.prepare(`
    INSERT INTO artifacts (id, run_id, type, path, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

    stmt.run(id, data.runId, data.type, data.path, JSON.stringify(data.metadata || null), now);

    return getArtifact(id)!;
}

export function getArtifact(id: string): Artifact | null {
    const db = getDatabase();
    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
        id: row.id as string,
        runId: row.run_id as string,
        type: row.type as ArtifactType,
        path: row.path as string,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
        createdAt: row.created_at as string,
    };
}

export function listArtifacts(runId: string, type?: ArtifactType): Artifact[] {
    const db = getDatabase();

    let query = 'SELECT * FROM artifacts WHERE run_id = ?';
    const params: unknown[] = [runId];

    if (type) {
        query += ' AND type = ?';
        params.push(type);
    }

    query += ' ORDER BY created_at ASC';

    const rows = db.prepare(query).all(...params) as Record<string, unknown>[];

    return rows.map(row => ({
        id: row.id as string,
        runId: row.run_id as string,
        type: row.type as ArtifactType,
        path: row.path as string,
        metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
        createdAt: row.created_at as string,
    }));
}

// ============================================================================
// Property Cache Operations (for dedup)
// ============================================================================

export function addToPropertyCache(data: {
    id: string;
    addressNormalized: string | null;
    zillowUrlNormalized: string | null;
    runId: string;
}): void {
    const db = getDatabase();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
    INSERT OR REPLACE INTO property_cache (id, address_normalized, zillow_url_normalized, run_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

    stmt.run(data.id, data.addressNormalized, data.zillowUrlNormalized, data.runId, now);
}

export function findDuplicateByAddress(normalizedAddress: string): string | null {
    const db = getDatabase();

    const row = db.prepare(
        'SELECT id FROM property_cache WHERE address_normalized = ? LIMIT 1'
    ).get(normalizedAddress) as { id: string } | undefined;

    return row?.id || null;
}

export function findDuplicateByZillowUrl(normalizedUrl: string): string | null {
    const db = getDatabase();

    const row = db.prepare(
        'SELECT id FROM property_cache WHERE zillow_url_normalized = ? LIMIT 1'
    ).get(normalizedUrl) as { id: string } | undefined;

    return row?.id || null;
}

// ============================================================================
// Settings Operations
// ============================================================================

export function getSetting(key: string): string | null {
    const db = getDatabase();

    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;

    return row?.value || null;
}

export function setSetting(key: string, value: string): void {
    const db = getDatabase();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
    INSERT OR REPLACE INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
  `);

    stmt.run(key, value, now);
}

export function getAllSettings(): Record<string, string> {
    const db = getDatabase();

    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];

    const settings: Record<string, string> = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }

    return settings;
}

// ============================================================================
// Property Operations (Local Cache)
// ============================================================================

export function saveProperties(properties: Partial<Property>[]): void {
    const db = getDatabase();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
    INSERT OR REPLACE INTO properties (id, run_id, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

    const insertMany = db.transaction((props: Partial<Property>[]) => {
        for (const p of props) {
            if (p.id && p.runId) {
                stmt.run(p.id, p.runId, JSON.stringify(p), p.createdAt || now, now);
            }
        }
    });

    insertMany(properties);
}

export function getPropertiesByRunId(runId: string): Property[] {
    const db = getDatabase();

    const rows = db.prepare('SELECT * FROM properties WHERE run_id = ?').all(runId) as Record<string, unknown>[];

    return rows.map(row => JSON.parse(row.data as string));
}

export function updateProperty(id: string, updates: Partial<Property>): Property | null {
    const db = getDatabase();
    const now = new Date().toISOString();

    // Get current property
    const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const currentData = JSON.parse(row.data as string) as Property;
    const newData = { ...currentData, ...updates, updatedAt: now };

    const stmt = db.prepare(`
    UPDATE properties 
    SET data = ?, updated_at = ?
    WHERE id = ?
  `);

    stmt.run(JSON.stringify(newData), now, id);

    return newData;
}

export type MarketStatus = 'active' | 'pending' | 'sold' | 'off-market' | 'unknown';
export type AvailabilitySource = 'zillow' | 'web-search' | 'manual' | 'claude-import' | 'none';

export function updatePropertyStatus(
    id: string,
    status: MarketStatus,
    source: AvailabilitySource = 'manual'
): Property | null {
    const now = new Date().toISOString();

    return updateProperty(id, {
        zillowStatus: status,
        availabilitySource: source,
        zillowLastChecked: now,
    });
}

// ============================================================================
// Analysis Operations (Local Cache)
// ============================================================================

export function saveAnalyses(analyses: Analysis[]): void {
    const db = getDatabase();
    const now = new Date().toISOString();

    const stmt = db.prepare(`
    INSERT OR REPLACE INTO analysis (id, property_id, run_id, data, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

    const insertMany = db.transaction((items: Analysis[]) => {
        for (const item of items) {
            stmt.run(item.id, item.propertyId, item.runId, JSON.stringify(item), now);
        }
    });

    insertMany(analyses);
}

export function getAnalysesByRunId(runId: string): Analysis[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM analysis WHERE run_id = ?').all(runId) as Record<string, unknown>[];
    return rows.map(row => JSON.parse(row.data as string));
}

// ============================================================================
// Close database on shutdown
// ============================================================================

export function closeDatabase(): void {
    if (db) {
        db.close();
        db = null;
    }
}
