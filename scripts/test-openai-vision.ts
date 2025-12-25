/**
 * Test script to verify OpenAI Vision extraction is working
 */

import * as fs from 'fs/promises';
import path from 'path';
import { pdfPageToImage } from '../lib/ocr/tesseract';
import { extractPropertiesWithLLM, getOpenAIClient } from '../lib/llm/openai';

async function main() {
    console.log('Testing OpenAI Vision extraction...\n');

    // Check if API key is available
    const client = getOpenAIClient();
    if (!client) {
        console.error('ERROR: OpenAI client not configured. Check OPENAI_API_KEY in .env.local');
        process.exit(1);
    }
    console.log('✓ OpenAI client configured\n');

    // Test PDF to image conversion
    const pdfPath = path.join(process.cwd(), 'data/uploads/Section8List12_19_25.pdf');
    const tempDir = path.join(process.cwd(), 'data/temp-test');

    await fs.mkdir(tempDir, { recursive: true });

    // Test multiple pages to find property listings
    for (const pageNum of [1, 2, 3, 5, 10]) {
        console.log(`\n--- Testing page ${pageNum} ---`);
        console.log('Converting PDF page to image...');
        const imageResult = await pdfPageToImage(pdfPath, pageNum, tempDir);

        if (!imageResult.success || !imageResult.imagePath) {
            console.log(`Page ${pageNum}: Failed to convert - ${imageResult.error}`);
            continue;
        }
        console.log('✓ PDF converted to image:', imageResult.imagePath);

        // Read the image and send to OpenAI
        console.log('Sending image to OpenAI Vision API...');
        const imgBuffer = await fs.readFile(imageResult.imagePath);

        try {
            const result = await extractPropertiesWithLLM(imgBuffer, pageNum);
            console.log('✓ Properties found:', result.properties.length);

            if (result.properties.length > 0) {
                console.log('First property:', JSON.stringify(result.properties[0], null, 2));
                // Cleanup and exit early on success
                await fs.unlink(imageResult.imagePath).catch(() => {});
                await fs.rm(tempDir, { recursive: true }).catch(() => {});
                console.log('\n✓ Found properties! Test passed.');
                return;
            }
        } catch (err) {
            console.error('ERROR: OpenAI extraction failed:', err);
        }

        // Cleanup
        await fs.unlink(imageResult.imagePath).catch(() => {});
    }

    await fs.rm(tempDir, { recursive: true }).catch(() => {});
    console.log('\nNo properties found on any tested page.');
}

main().catch(console.error);
