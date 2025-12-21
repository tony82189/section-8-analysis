import * as fs from 'fs';
import path from 'path';
import { runPipeline } from '../lib/pipeline/orchestrator';
import { ocrPdfPage } from '../lib/ocr/tesseract';
import { parsePropertiesFromText, normalizeOcrText } from '../lib/parser/section8';

async function debug() {
    const filePath = path.join(process.cwd(), 'data/uploads/Section8List12_19_25.pdf');
    const tempDir = path.join(process.cwd(), 'data/debug-temp');

    if (!fs.existsSync(filePath)) {
        console.error('File not found:', filePath);
        process.exit(1);
    }

    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    console.log('Running OCR on Page 1...');
    // OCR page 1
    const ocrResult = await ocrPdfPage(filePath, 1, tempDir);

    if (!ocrResult.success) {
        console.error('OCR Failed:', ocrResult.error);
        return;
    }

    console.log('\n--- RAW OCR TEXT ---');
    console.log(ocrResult.text.substring(0, 1000) + '...');

    const normalized = normalizeOcrText(ocrResult.text);
    console.log('\n--- NORMALIZED TEXT ---');
    console.log(normalized.substring(0, 1000) + '...');

    console.log('\n--- PARSING ---');
    const result = parsePropertiesFromText(normalized, 'debug-run');

    console.log('Properties found:', result.properties.length);
    console.log('Errors:', result.errors);

    if (result.properties.length > 0) {
        console.log('\nFirst Property:', JSON.stringify(result.properties[0], null, 2));
    } else {
        // If 0 properties, let's debug the splitting logic
        console.log('\nDEBUGGING SPLIT LOGIC:');
        const records = normalized.split(/(?=https?:\/\/(?:www\.)?zillow\.com\/homedetails\/)/gi);
        console.log('Split by Zillow URL found', records.length, 'chunks');

        // Dump first chunk to see what's wrong
        if (records.length > 0) {
            console.log('First chunk:', records[0].substring(0, 300));
        }
    }
}

debug();
