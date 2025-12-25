import { NextRequest, NextResponse } from 'next/server';
import { runPipeline } from '@/lib/pipeline/orchestrator';
import { mergeSettings, getDefaultSettings } from '@/lib/filter/engine';
import { v4 as uuidv4 } from 'uuid';
import { createRun, getAllSettings } from '@/lib/db/sqlite';
import { computeBufferHash } from '@/lib/pdf/splitter';
import type { Settings } from '@/lib/types';

// Use require for pdf-parse to avoid ESM issues
const pdfParse = require('pdf-parse');

/**
 * Load saved settings from database (same pattern as GET /api/settings)
 */
function loadSavedSettings(): Partial<Settings> {
    const stored = getAllSettings();
    const defaults = getDefaultSettings();
    const parsed: Partial<Settings> = {};

    for (const [key, value] of Object.entries(stored)) {
        if (key in defaults) {
            const defaultValue = (defaults as Record<string, unknown>)[key];
            if (typeof defaultValue === 'number') {
                parsed[key as keyof Settings] = parseFloat(value) as never;
            } else if (typeof defaultValue === 'boolean') {
                parsed[key as keyof Settings] = (value === 'true') as never;
            } else {
                parsed[key as keyof Settings] = value as never;
            }
        }
    }
    return parsed;
}

export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get('file') as File | null;
        const dryRun = formData.get('dryRun') === 'true';
        const settingsJson = formData.get('settings') as string | null;

        if (!file) {
            return NextResponse.json(
                { success: false, error: 'No file uploaded' },
                { status: 400 }
            );
        }

        // Validate file type
        if (!file.name.toLowerCase().endsWith('.pdf')) {
            return NextResponse.json(
                { success: false, error: 'File must be a PDF' },
                { status: 400 }
            );
        }

        // Parse settings: use provided JSON, OR load from DB, OR use defaults
        const settings = settingsJson
            ? mergeSettings(JSON.parse(settingsJson))
            : mergeSettings(loadSavedSettings());

        // Read file buffer
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const fileName = file.name;
        const fileHash = computeBufferHash(buffer);

        // 1. Generate Run ID immediately
        const runId = uuidv4();

        // 2. Create the initial 'pending' record in DB so client can poll immediately
        createRun({
            id: runId,
            fileHash,
            fileName,
            fileSize: buffer.length,
            dryRun,
        });

        // 3. Kick off pipeline in background (fire and forget)
        // Note: For deployed serverless (Vercel), waiting might be required or use a proper queue.
        // For local usage (npm run start/dev), this background task persists.
        runPipeline(buffer, fileName, {
            runId, // Pass the ID we just created
            dryRun,
            targetStage: 'extract-only', // Always stop after extraction/dedup
            settings,
            onProgress: (step, progress, message) => {
                console.log(`[${runId}][${step}] ${progress}% - ${message}`);
            },
        }).catch(err => {
            console.error(`Background pipeline failed for ${runId}:`, err);
        });

        // 4. Return success immediately with runId
        return NextResponse.json({
            success: true,
            data: {
                runId,
                message: 'Upload successful, processing started in background',
            },
        });

    } catch (error) {
        console.error('Upload error:', error);
        const message = error instanceof Error ? error.message : 'Upload failed';
        return NextResponse.json(
            { success: false, error: message },
            { status: 500 }
        );
    }
}

export async function GET() {
    return NextResponse.json({
        message: 'Use POST to upload a PDF file',
        endpoints: {
            upload: 'POST /api/upload with multipart/form-data',
            params: {
                file: 'PDF file (required)',
                dryRun: 'boolean - stop after extraction+filter (optional)',
                settings: 'JSON string of settings (optional)',
            },
        },
    });
}
