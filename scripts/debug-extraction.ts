/**
 * Debug script to understand why page boundary extraction isn't working
 */

import * as fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import { extractTextFromBuffer, hasSelectableText } from '../lib/pdf/extractor';
import { parsePropertiesFromText } from '../lib/parser/section8';

interface Artifact {
    path: string;
    metadata: string;
}

async function debugExtraction() {
    const dataDir = path.join(process.cwd(), 'data');

    // Use a specific run with data
    const latestRun = 'd122cbee-7da0-4253-a8b6-d896d5adfcb4';

    console.log(`Analyzing run: ${latestRun}`);

    // Get chunk paths from database
    const db = new Database(path.join(dataDir, 'section8.db'));
    const artifacts = db.prepare(`
        SELECT path, metadata FROM artifacts
        WHERE run_id = ? AND type = 'chunk-pdf'
    `).all(latestRun) as Artifact[];
    db.close();

    // Sort by page number
    const chunks = artifacts.map(a => ({
        path: a.path,
        pageNum: JSON.parse(a.metadata).pageStart as number
    })).sort((a, b) => a.pageNum - b.pageNum);

    console.log(`Found ${chunks.length} page chunks`);

    // Extract text from all pages
    const pageTexts: Map<number, string> = new Map();
    const pagesWithProperties = new Set<number>();

    for (const chunk of chunks) {
        const buffer = await fs.readFile(chunk.path);

        const hasText = await hasSelectableText(buffer);
        if (hasText) {
            const extracted = await extractTextFromBuffer(buffer);
            if (extracted.text.length > 50) {
                pageTexts.set(chunk.pageNum, extracted.text);
            }
        }
    }

    console.log(`\nExtracted text from ${pageTexts.size} pages\n`);

    // First pass: parse each page individually
    console.log('=== FIRST PASS (single page) ===');
    let totalFirstPass = 0;
    interface ParsedProperty {
        address?: string | null;
        zillowUrl?: string | null;
        askingPrice?: number | null;
        rent?: number | null;
    }
    const allParsedProperties: ParsedProperty[] = [];

    for (const [pageNum, text] of pageTexts) {
        const result = parsePropertiesFromText(text, 'test', { sourcePage: pageNum });
        const withPricing = result.properties.filter(p => p.askingPrice || p.rent);

        if (withPricing.length > 0) {
            pagesWithProperties.add(pageNum);
            totalFirstPass += withPricing.length;
            allParsedProperties.push(...withPricing);
        }
    }

    console.log(`Total first pass: ${totalFirstPass} properties from ${pagesWithProperties.size} pages`);

    const pagesWithoutProperties = [...pageTexts.keys()].filter(p => !pagesWithProperties.has(p)).sort((a,b) => a-b);
    console.log(`\nPages WITHOUT properties: ${pagesWithoutProperties.join(', ')}`);
    console.log(`Total: ${pagesWithoutProperties.length} pages\n`);

    // Second pass: try sliding window on pages without properties
    console.log('=== SECOND PASS (sliding window) - detailed analysis ===\n');

    let boundaryPropertiesFound = 0;

    for (const pageNum of pagesWithoutProperties) { // Analyze ALL empty pages
        const prevText = pageTexts.get(pageNum - 1) || '';
        const currText = pageTexts.get(pageNum) || '';

        if (!prevText) {
            console.log(`Page ${pageNum}: No previous page text, skipping\n`);
            continue;
        }

        const windowText = prevText + '\n\n' + currText;
        const result = parsePropertiesFromText(windowText, 'test', { sourcePage: pageNum });
        const withPricing = result.properties.filter(p => p.askingPrice || p.rent);

        console.log(`Page ${pageNum} (window with ${pageNum-1}):`);
        console.log(`  Raw parser output: ${result.properties.length} properties`);
        console.log(`  With pricing: ${withPricing.length}`);

        if (withPricing.length === 0) {
            console.log(`  Current page text (first 300 chars):\n    ${currText.substring(0, 300).replace(/\n/g, '\n    ')}`);
            console.log(`\n`);
            continue;
        }

        // Check pricing location for each property
        // Helper to check if price appears in text (handles multiple formats)
        const priceMatchesInText = (price: number | null | undefined, text: string): boolean => {
            if (!price) return false;
            const textLower = text.toLowerCase();

            // Generate possible formats for this price
            const formats: string[] = [
                price.toString(),                          // 85000
                price.toLocaleString(),                    // 85,000
                `$${price.toString()}`,                    // $85000
                `$${price.toLocaleString()}`,              // $85,000
            ];

            // Add "k" suffix formats for prices >= 1000
            if (price >= 1000) {
                const inK = price / 1000;
                if (Number.isInteger(inK)) {
                    formats.push(`${inK}k`);               // 85k
                    formats.push(`$${inK}k`);              // $85k
                } else {
                    // Handle non-round thousands like 39900 -> 39.9k
                    const rounded = Math.round(inK * 10) / 10;
                    formats.push(`${rounded}k`);           // 39.9k
                    formats.push(`$${rounded}k`);          // $39.9k
                }
            }

            return formats.some(fmt => textLower.includes(fmt.toLowerCase()));
        };

        for (const prop of withPricing) {
            const pricingInCurrent = priceMatchesInText(prop.askingPrice, currText) ||
                                      priceMatchesInText(prop.rent, currText);
            const pricingInPrev = priceMatchesInText(prop.askingPrice, prevText) ||
                                   priceMatchesInText(prop.rent, prevText);

            console.log(`  Property: ${prop.address || 'NO ADDRESS'}`);
            console.log(`    askingPrice: $${prop.askingPrice?.toLocaleString() || 'N/A'}, rent: $${prop.rent?.toLocaleString() || 'N/A'}`);
            console.log(`    zillowUrl: ${prop.zillowUrl ? 'YES' : 'NO'}`);
            console.log(`    Pricing found in current page: ${pricingInCurrent}`);
            console.log(`    Pricing found in previous page: ${pricingInPrev}`);

            if (pricingInCurrent) {
                // Check for duplicates (same as production code)
                const addrKey = prop.address?.toLowerCase().trim();
                const urlKey = prop.zillowUrl?.toLowerCase().trim();

                const isDuplicate = allParsedProperties.some(existing => {
                    const existingAddr = existing.address?.toLowerCase().trim();
                    const existingUrl = existing.zillowUrl?.toLowerCase().trim();
                    return (addrKey && existingAddr === addrKey) ||
                           (urlKey && existingUrl === urlKey);
                });

                if (isDuplicate) {
                    console.log(`    => DUPLICATE (already found in first pass)`);
                } else {
                    boundaryPropertiesFound++;
                    allParsedProperties.push(prop); // Add to prevent duplicates
                    console.log(`    => NEW BOUNDARY PROPERTY DETECTED`);
                }
            } else {
                console.log(`    => Belongs to previous page`);
            }
        }
        console.log(`\n`);
    }

    console.log(`\n=== SUMMARY ===`);
    console.log(`First pass: ${totalFirstPass} properties from ${pagesWithProperties.size} pages`);
    console.log(`Pages without properties: ${pagesWithoutProperties.length}`);
    console.log(`NEW boundary properties found in sliding window: ${boundaryPropertiesFound}`);
    console.log(`Total properties: ${allParsedProperties.length}`);
}

debugExtraction().catch(console.error);
