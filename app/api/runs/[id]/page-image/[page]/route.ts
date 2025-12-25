import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import path from 'path';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; page: string }> }
) {
    const { id: runId, page: pageNumber } = await params;

    // Validate inputs
    if (!runId || !pageNumber) {
        return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
    }

    // Sanitize to prevent path traversal
    const sanitizedRunId = runId.replace(/[^a-zA-Z0-9-]/g, '');
    const sanitizedPage = pageNumber.replace(/[^0-9]/g, '');

    const imagePath = path.join(
        process.cwd(),
        'data', 'runs', sanitizedRunId, 'images',
        `page_${sanitizedPage}.png`
    );

    try {
        const imageBuffer = await fs.readFile(imagePath);
        return new NextResponse(imageBuffer, {
            headers: {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=31536000',
            },
        });
    } catch {
        return NextResponse.json({ error: 'Image not found' }, { status: 404 });
    }
}
