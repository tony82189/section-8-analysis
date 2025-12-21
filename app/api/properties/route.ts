import { NextRequest, NextResponse } from 'next/server';
import { getPropertiesByRunId, updateProperty } from '@/lib/db/sqlite';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const runId = searchParams.get('runId');

        if (!runId) {
            return NextResponse.json(
                { success: false, error: 'Run ID is required' },
                { status: 400 }
            );
        }

        const properties = getPropertiesByRunId(runId);

        return NextResponse.json({
            success: true,
            data: properties,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Error fetching properties';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}

export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { id, ...updates } = body;

        if (!id) {
            return NextResponse.json(
                { success: false, error: 'Property ID is required' },
                { status: 400 }
            );
        }

        const property = updateProperty(id, updates);

        if (!property) {
            return NextResponse.json({ success: false, error: 'Property not found' }, { status: 404 });
        }

        return NextResponse.json({
            success: true,
            data: property
        });

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Error updating property';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
