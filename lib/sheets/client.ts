/**
 * Google Sheets Client
 * 
 * Provides read/write access to Google Sheets for persistent storage.
 * Uses service account authentication.
 */

import { google, sheets_v4 } from 'googleapis';
import type { Property, Analysis, Run, Settings } from '../types';

// Sheet names
const SHEETS = {
    PROPERTIES: 'Properties',
    ANALYSIS: 'Analysis',
    RUNS: 'Runs',
    SETTINGS: 'Settings',
};

// Column mappings for each sheet
const PROPERTY_COLUMNS = [
    'id', 'runId', 'address', 'city', 'state', 'zip',
    'askingPrice', 'suggestedOffer', 'rent', 'bedrooms', 'bathrooms',
    'sqft', 'yearBuilt', 'occupied', 'section8Tenant',
    'zillowUrl', 'zillowStatus', 'zillowZestimate', 'zillowLastChecked',
    'status', 'discardReason', 'needsManualReview', 'reviewNotes',
    'sourceChunk', 'sourcePage', 'createdAt', 'updatedAt'
];

const ANALYSIS_COLUMNS = [
    'id', 'propertyId', 'runId',
    'purchasePrice', 'downPaymentPercent', 'closingCostPercent',
    'interestRate', 'loanTermYears', 'pmFeePercent',
    'vacancyPercent', 'maintenancePercent', 'propertyTaxRate', 'insuranceAnnual',
    'downPayment', 'closingCosts', 'loanAmount', 'totalInvestment',
    'monthlyPI', 'monthlyTaxes', 'monthlyInsurance', 'monthlyPITI',
    'monthlyRent', 'pmFee', 'vacancy', 'maintenance',
    'totalExpenses', 'netCashflow', 'annualCashflow', 'annualNOI',
    'dscr', 'capRate', 'cocReturn',
    'equity5yr', 'equity10yr', 'equity20yr',
    'cashflow5yr', 'cashflow10yr', 'cashflow20yr',
    'totalReturn5yr', 'totalReturn10yr', 'totalReturn20yr',
    'rankScore', 'rank', 'createdAt'
];

const RUN_COLUMNS = [
    'id', 'fileHash', 'fileName', 'filePath', 'fileSize',
    'status', 'dryRun', 'currentStep', 'progress',
    'totalPages', 'chunksCreated', 'propertiesExtracted',
    'propertiesFiltered', 'propertiesDeduped', 'propertiesAnalyzed', 'topNCount',
    'error', 'createdAt', 'startedAt', 'completedAt'
];

let sheetsClient: sheets_v4.Sheets | null = null;
let spreadsheetId: string | null = null;

/**
 * Initialize the Sheets client with service account credentials
 */
export async function initializeSheetsClient(
    credentials: {
        client_email: string;
        private_key: string;
    },
    sheetId: string
): Promise<void> {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: credentials.client_email,
            private_key: credentials.private_key,
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    sheetsClient = google.sheets({ version: 'v4', auth });
    spreadsheetId = sheetId;

    // Ensure required sheets exist
    await ensureSheetsExist();
}

/**
 * Initialize from environment variables
 */
export async function initializeFromEnv(): Promise<boolean> {
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const sheetId = process.env.GOOGLE_SPREADSHEET_ID;

    if (!clientEmail || !privateKey || !sheetId) {
        console.warn('Google Sheets credentials not configured');
        return false;
    }

    await initializeSheetsClient(
        { client_email: clientEmail, private_key: privateKey },
        sheetId
    );
    return true;
}

/**
 * Ensure all required sheets exist in the spreadsheet
 */
async function ensureSheetsExist(): Promise<void> {
    if (!sheetsClient || !spreadsheetId) {
        throw new Error('Sheets client not initialized');
    }

    // Get existing sheets
    const response = await sheetsClient.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties.title',
    });

    const existingSheets = response.data.sheets?.map(s => s.properties?.title) || [];

    // Create missing sheets
    const requests: sheets_v4.Schema$Request[] = [];

    for (const sheetName of Object.values(SHEETS)) {
        if (!existingSheets.includes(sheetName)) {
            requests.push({
                addSheet: {
                    properties: { title: sheetName },
                },
            });
        }
    }

    if (requests.length > 0) {
        await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests },
        });

        // Add headers to new sheets
        await addHeaders();
    }
}

/**
 * Add header rows to sheets
 */
async function addHeaders(): Promise<void> {
    if (!sheetsClient || !spreadsheetId) return;

    const updates = [
        { range: `${SHEETS.PROPERTIES}!A1`, values: [PROPERTY_COLUMNS] },
        { range: `${SHEETS.ANALYSIS}!A1`, values: [ANALYSIS_COLUMNS] },
        { range: `${SHEETS.RUNS}!A1`, values: [RUN_COLUMNS] },
        { range: `${SHEETS.SETTINGS}!A1`, values: [['key', 'value', 'type', 'description']] },
    ];

    for (const update of updates) {
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId,
            range: update.range,
            valueInputOption: 'RAW',
            requestBody: { values: update.values },
        });
    }
}

// ============================================================================
// Property Operations
// ============================================================================

/**
 * Append properties to the sheet
 */
export async function appendProperties(properties: Partial<Property>[]): Promise<void> {
    if (!sheetsClient || !spreadsheetId) {
        throw new Error('Sheets client not initialized');
    }

    const rows = properties.map(p =>
        PROPERTY_COLUMNS.map(col => {
            const value = (p as Record<string, unknown>)[col];
            if (value === null || value === undefined) return '';
            if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
            return String(value);
        })
    );

    await sheetsClient.spreadsheets.values.append({
        spreadsheetId,
        range: `${SHEETS.PROPERTIES}!A:Z`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
    });
}

/**
 * Get all properties for a run
 */
export async function getPropertiesByRunId(runId: string): Promise<Partial<Property>[]> {
    if (!sheetsClient || !spreadsheetId) {
        throw new Error('Sheets client not initialized');
    }

    const response = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEETS.PROPERTIES}!A:AA`,
    });

    const rows = response.data.values || [];
    if (rows.length <= 1) return []; // Only header or empty

    const headers = rows[0];
    const properties: Partial<Property>[] = [];

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const property: Record<string, unknown> = {};

        for (let j = 0; j < headers.length; j++) {
            const col = headers[j];
            const value = row[j];

            if (value !== undefined && value !== '') {
                // Parse based on column type
                if (['askingPrice', 'suggestedOffer', 'rent', 'sqft', 'bedrooms', 'bathrooms', 'yearBuilt', 'zillowZestimate', 'sourcePage'].includes(col)) {
                    property[col] = parseFloat(value) || null;
                } else if (['occupied', 'section8Tenant', 'needsManualReview'].includes(col)) {
                    property[col] = value === 'TRUE' || value === 'true';
                } else {
                    property[col] = value;
                }
            }
        }

        if (property.runId === runId) {
            properties.push(property as Partial<Property>);
        }
    }

    return properties;
}

/**
 * Update a property by ID
 */
export async function updateProperty(id: string, updates: Partial<Property>): Promise<boolean> {
    if (!sheetsClient || !spreadsheetId) {
        throw new Error('Sheets client not initialized');
    }

    // Find the row with this ID
    const response = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEETS.PROPERTIES}!A:A`,
    });

    const ids = response.data.values?.flat() || [];
    const rowIndex = ids.indexOf(id);

    if (rowIndex === -1) return false;

    // Get current row data
    const rowResponse = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEETS.PROPERTIES}!A${rowIndex + 1}:AA${rowIndex + 1}`,
    });

    const currentRow = rowResponse.data.values?.[0] || [];

    // Merge updates
    const newRow = PROPERTY_COLUMNS.map((col, i) => {
        if (col in updates) {
            const value = (updates as Record<string, unknown>)[col];
            if (value === null || value === undefined) return '';
            if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
            return String(value);
        }
        return currentRow[i] || '';
    });

    await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEETS.PROPERTIES}!A${rowIndex + 1}:AA${rowIndex + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [newRow] },
    });

    return true;
}

// ============================================================================
// Analysis Operations
// ============================================================================

/**
 * Append analysis results to the sheet
 */
export async function appendAnalysis(analyses: Partial<Analysis>[]): Promise<void> {
    if (!sheetsClient || !spreadsheetId) {
        throw new Error('Sheets client not initialized');
    }

    const rows = analyses.map(a =>
        ANALYSIS_COLUMNS.map(col => {
            const value = (a as Record<string, unknown>)[col];
            if (value === null || value === undefined) return '';
            return String(value);
        })
    );

    await sheetsClient.spreadsheets.values.append({
        spreadsheetId,
        range: `${SHEETS.ANALYSIS}!A:AQ`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
    });
}

// ============================================================================
// Run Operations
// ============================================================================

/**
 * Append a run to the sheet
 */
export async function appendRun(run: Partial<Run>): Promise<void> {
    if (!sheetsClient || !spreadsheetId) {
        throw new Error('Sheets client not initialized');
    }

    const row = RUN_COLUMNS.map(col => {
        const value = (run as Record<string, unknown>)[col];
        if (value === null || value === undefined) return '';
        if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
        return String(value);
    });

    await sheetsClient.spreadsheets.values.append({
        spreadsheetId,
        range: `${SHEETS.RUNS}!A:T`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
    });
}

/**
 * Update a run by ID
 */
export async function updateRun(id: string, updates: Partial<Run>): Promise<boolean> {
    if (!sheetsClient || !spreadsheetId) {
        throw new Error('Sheets client not initialized');
    }

    // Find the row with this ID
    const response = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEETS.RUNS}!A:A`,
    });

    const ids = response.data.values?.flat() || [];
    const rowIndex = ids.indexOf(id);

    if (rowIndex === -1) return false;

    // Get current row data
    const rowResponse = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEETS.RUNS}!A${rowIndex + 1}:T${rowIndex + 1}`,
    });

    const currentRow = rowResponse.data.values?.[0] || [];

    // Merge updates
    const newRow = RUN_COLUMNS.map((col, i) => {
        if (col in updates) {
            const value = (updates as Record<string, unknown>)[col];
            if (value === null || value === undefined) return '';
            if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
            return String(value);
        }
        return currentRow[i] || '';
    });

    await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEETS.RUNS}!A${rowIndex + 1}:T${rowIndex + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [newRow] },
    });

    return true;
}

// ============================================================================
// Settings Operations
// ============================================================================

/**
 * Get all settings from the sheet
 */
export async function getSettings(): Promise<Partial<Settings>> {
    if (!sheetsClient || !spreadsheetId) {
        throw new Error('Sheets client not initialized');
    }

    const response = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${SHEETS.SETTINGS}!A:D`,
    });

    const rows = response.data.values || [];
    if (rows.length <= 1) return {};

    const settings: Record<string, unknown> = {};

    for (let i = 1; i < rows.length; i++) {
        const [key, value, type] = rows[i];
        if (key && value !== undefined) {
            if (type === 'number') {
                settings[key] = parseFloat(value);
            } else if (type === 'boolean') {
                settings[key] = value === 'true' || value === 'TRUE';
            } else {
                settings[key] = value;
            }
        }
    }

    return settings as Partial<Settings>;
}

/**
 * Save settings to the sheet
 */
export async function saveSettings(settings: Partial<Settings>): Promise<void> {
    if (!sheetsClient || !spreadsheetId) {
        throw new Error('Sheets client not initialized');
    }

    const rows = [['key', 'value', 'type', 'description']];

    for (const [key, value] of Object.entries(settings)) {
        if (value !== undefined) {
            const type = typeof value;
            rows.push([key, String(value), type, '']);
        }
    }

    // Clear and rewrite settings
    await sheetsClient.spreadsheets.values.clear({
        spreadsheetId,
        range: `${SHEETS.SETTINGS}!A:D`,
    });

    await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEETS.SETTINGS}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: rows },
    });
}

/**
 * Check if sheets client is initialized and connected
 */
export function isConnected(): boolean {
    return sheetsClient !== null && spreadsheetId !== null;
}

/**
 * Get the spreadsheet ID
 */
export function getSpreadsheetId(): string | null {
    return spreadsheetId;
}
