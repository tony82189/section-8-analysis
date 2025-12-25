import { NextRequest, NextResponse } from 'next/server';
import { updatePropertyStatus, type MarketStatus } from '@/lib/db/sqlite';

const VALID_STATUSES: MarketStatus[] = ['active', 'pending', 'sold', 'off-market', 'unknown'];

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const body = await request.json();
        const { status, source = 'manual' } = body;

        if (!id) {
            return NextResponse.json(
                { success: false, error: 'Property ID is required' },
                { status: 400 }
            );
        }

        if (!status || !VALID_STATUSES.includes(status)) {
            return NextResponse.json(
                { success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` },
                { status: 400 }
            );
        }

        const property = updatePropertyStatus(id, status as MarketStatus, source);

        if (!property) {
            return NextResponse.json(
                { success: false, error: 'Property not found' },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            data: property
        });

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Error updating property status';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
