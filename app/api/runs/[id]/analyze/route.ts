import { NextRequest, NextResponse } from 'next/server';
import { resumePipeline } from '@/lib/pipeline/orchestrator';

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const body = await request.json();
        const { settings } = body;

        if (!id) {
            return NextResponse.json(
                { success: false, error: 'Run ID is required' },
                { status: 400 }
            );
        }

        // Resume the pipeline
        const result = await resumePipeline(id, {
            settings,
            onProgress: (step, progress, message) => {
                console.log(`[RESUME:${id}] [${step}] ${progress}% - ${message}`);
            },
        });

        if (!result.success) {
            return NextResponse.json(
                { success: false, error: result.error },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            data: {
                runId: result.runId,
                run: result.run,
                propertiesCount: result.properties.length,
                analysesCount: result.analyses.length,
                topNCount: result.ranked.length,
                reports: result.reports,
            },
        });

    } catch (error) {
        console.error('Analysis error:', error);
        const message = error instanceof Error ? error.message : 'Analysis failed';
        return NextResponse.json(
            { success: false, error: message },
            { status: 500 }
        );
    }
}
