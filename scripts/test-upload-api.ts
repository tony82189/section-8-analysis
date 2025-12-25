/**
 * Test uploading a small PDF to verify the pipeline uses OpenAI Vision
 */

import * as fs from 'fs/promises';
import path from 'path';

async function main() {
    console.log('Testing upload API with OpenAI Vision...\n');

    const pdfPath = path.join(process.cwd(), 'data/uploads/Section8List12_19_25.pdf');
    const pdfBuffer = await fs.readFile(pdfPath);

    // Create form data
    const formData = new FormData();
    const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
    formData.append('file', blob, 'Section8List12_19_25.pdf');

    console.log('Uploading PDF to API...');
    const response = await fetch('http://localhost:3000/api/upload', {
        method: 'POST',
        body: formData,
    });

    const result = await response.json();
    console.log('Upload response:', result);

    if (!result.success) {
        console.error('Upload failed:', result.error);
        process.exit(1);
    }

    const runId = result.data.runId;
    console.log('Run ID:', runId);

    // Poll for status
    console.log('\nPolling for status...');
    for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));

        const statusRes = await fetch('http://localhost:3000/api/runs');
        const statusData = await statusRes.json();

        const run = statusData.data?.runs?.find((r: any) => r.id === runId);
        if (run) {
            console.log(`Status: ${run.status}, Properties: ${run.propertiesExtracted || 0}`);

            if (run.status === 'waiting-for-review' || run.status === 'completed') {
                console.log('\n✓ Pipeline completed!');
                console.log('Final properties extracted:', run.propertiesExtracted);
                console.log('Properties after dedup:', run.propertiesDeduped);
                break;
            }

            if (run.status === 'failed') {
                console.error('Pipeline failed:', run.error);
                process.exit(1);
            }
        }
    }
}

main().catch(console.error);
