import { NextRequest, NextResponse } from 'next/server';
import { listRuns, getRun, updateRun } from '@/lib/db/sqlite';

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
        const { id, ...updates } = body;

        if (!id) {
            return NextResponse.json(
                { success: false, error: 'Run ID is required' },
                { status: 400 }
            );
        }

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
