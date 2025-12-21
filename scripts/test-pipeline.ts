import * as fs from 'fs';
import path from 'path';
import { runPipeline } from '../lib/pipeline/orchestrator';

async function test() {
    const filePath = path.join(process.cwd(), 'data/uploads/Section8List12_19_25.pdf');

    if (!fs.existsSync(filePath)) {
        console.error('File not found:', filePath);
        process.exit(1);
    }

    const buffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    console.log('Starting pipeline test for:', fileName);
    console.log('Size:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');

    try {
        const result = await runPipeline(buffer, fileName, {
            dryRun: true, // Stop before Zillow checks for speed
            onProgress: (step, progress, message) => {
                console.log(`[${step}] ${Math.round(progress)}% - ${message}`);
            },
        });

        if (result.success) {
            console.log('\n✅ Pipeline succeeded!');
            console.log('Run ID:', result.runId);
            console.log('Properties Found:', result.properties.length);
            console.log('Unique Properties:', result.properties.length); // logic check

            if (result.properties.length > 0) {
                console.log('\nSample Property:', JSON.stringify(result.properties[0], null, 2));
            }
        } else {
            console.error('\n❌ Pipeline failed:', result.error);
        }

    } catch (error: any) {
        console.error('Test error:', error.message);
        console.error(error.stack);
    }
}

test();
