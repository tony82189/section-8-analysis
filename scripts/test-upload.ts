import * as fs from 'fs/promises';
import path from 'path';

async function testUpload() {
    const pdfPath = path.join(process.cwd(), 'data/runs/d122cbee-7da0-4253-a8b6-d896d5adfcb4/original.pdf');
    const pdfBuffer = await fs.readFile(pdfPath);

    // Create FormData-like payload
    const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
        Buffer.from(header),
        pdfBuffer,
        Buffer.from(footer)
    ]);

    console.log('Uploading PDF...');

    const response = await fetch('http://localhost:3000/api/upload', {
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: body
    });

    const result = await response.json();
    console.log('Upload response:', result);

    if (result.runId) {
        console.log('\nPolling for completion...');

        // Poll for status
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 2000));

            const statusResp = await fetch(`http://localhost:3000/api/runs`);
            const runs = await statusResp.json();
            const run = runs.find((r: { id: string }) => r.id === result.runId) as {
                id: string;
                status: string;
                propertiesExtracted: number | null;
                propertiesFiltered: number | null;
                propertiesDeduped: number | null;
            } | undefined;

            if (run) {
                console.log(`Status: ${run.status}, Extracted: ${run.propertiesExtracted || 0}, Filtered: ${run.propertiesFiltered || 0}`);

                if (run.status === 'waiting-for-review' || run.status === 'error' || run.status === 'completed') {
                    console.log('\n=== FINAL RESULTS ===');
                    console.log(`Properties Extracted: ${run.propertiesExtracted}`);
                    console.log(`Properties Filtered: ${run.propertiesFiltered}`);
                    console.log(`Properties Deduped: ${run.propertiesDeduped}`);
                    break;
                }
            }
        }
    }
}

testUpload().catch(console.error);
