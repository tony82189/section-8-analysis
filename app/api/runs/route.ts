import { NextRequest, NextResponse } from 'next/server';
import { listRuns, getRun, updateRun, deleteRun, deleteAllRuns, clearPropertiesForRun } from '@/lib/db/sqlite';
import * as fs from 'fs/promises';
import path from 'path';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');
        const limit = parseInt(searchParams.get('limit') || '50', 10);
        const offset = parseInt(searchParams.get('offset') || '0', 10);

        if (id) {
            // Get specific run
            const run = getRun(id);
            if (!run) {
                return NextResponse.json(
                    { success: false, error: 'Run not found' },
                    { status: 404 }
                );
            }
            return NextResponse.json({ success: true, data: run });
        }

        // List all runs
        const runs = listRuns({ limit, offset });
        return NextResponse.json({
            success: true,
            data: {
                runs,
                total: runs.length,
                limit,
                offset,
            },
        });

    } catch (error) {
        console.error('Runs API error:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch runs';
        return NextResponse.json(
            { success: false, error: message },
            { status: 500 }
        );
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { id, action, ...updates } = body;

        if (!id) {
            return NextResponse.json(
                { success: false, error: 'Run ID is required' },
                { status: 400 }
            );
        }

        // Handle clear-properties action
        if (action === 'clear-properties') {
            const result = clearPropertiesForRun(id);
            if (result.deletedCount === 0) {
                // Check if run exists
                const run = getRun(id);
                if (!run) {
                    return NextResponse.json(
                        { success: false, error: 'Run not found' },
                        { status: 404 }
                    );
                }
            }
            return NextResponse.json({
                success: true,
                message: `Cleared ${result.deletedCount} properties`,
                deletedCount: result.deletedCount
            });
        }

        // Standard update
        const run = updateRun(id, updates);
        if (!run) {
            return NextResponse.json(
                { success: false, error: 'Run not found' },
                { status: 404 }
            );
        }

        return NextResponse.json({ success: true, data: run });

    } catch (error) {
        console.error('Runs API error:', error);
        const message = error instanceof Error ? error.message : 'Failed to update run';
        return NextResponse.json(
            { success: false, error: message },
            { status: 500 }
        );
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');
        const all = searchParams.get('all');

        // Handle "clear all" request
        if (all === 'true') {
            const result = deleteAllRuns();

            // Delete all run data directories
            const runsDir = path.join(process.cwd(), 'data', 'runs');
            for (const runId of result.runIds) {
                try {
                    await fs.rm(path.join(runsDir, runId), { recursive: true, force: true });
                } catch {
                    // Directory may not exist, ignore errors
                }
            }

            return NextResponse.json({
                success: true,
                message: `Deleted ${result.deletedCount} runs`,
                deletedCount: result.deletedCount
            });
        }

        // Handle single run delete
        if (!id) {
            return NextResponse.json(
                { success: false, error: 'Run ID is required' },
                { status: 400 }
            );
        }

        // Delete from database
        const deleted = deleteRun(id);
        if (!deleted) {
            return NextResponse.json(
                { success: false, error: 'Run not found' },
                { status: 404 }
            );
        }

        // Also delete the run's data directory
        const runDir = path.join(process.cwd(), 'data', 'runs', id);
        try {
            await fs.rm(runDir, { recursive: true, force: true });
        } catch {
            // Directory may not exist, ignore errors
        }

        return NextResponse.json({ success: true, message: 'Run deleted successfully' });

    } catch (error) {
        console.error('Runs API delete error:', error);
        const message = error instanceof Error ? error.message : 'Failed to delete run';
        return NextResponse.json(
            { success: false, error: message },
            { status: 500 }
        );
    }
}
