/**
 * Pipeline Orchestrator
 * 
 * Coordinates the full property analysis pipeline:
 * 1. Split PDF into chunks
 * 2. Extract text (or OCR)
 * 3. Parse properties
 * 4. Filter properties
 * 5. Deduplicate
 * 6. Check Zillow status
 * 7. Run underwriting
 * 8. Generate forecasts
 * 9. Rank properties
 * 10. Generate reports
 */

import * as fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { splitPdf, computeBufferHash } from '../pdf/splitter';
import { extractTextFromBuffer, hasSelectableText } from '../pdf/extractor';
import { extractPropertiesWithRetry, verifyExtractedProperties } from '../llm/openai';
import { ocrPdfPage, pdfPageToImage, terminateOcrWorker } from '../ocr/tesseract';
import { validatePropertyData } from '../validation/checker';
import { parsePropertiesFromText, normalizeOcrText, extractAddressFromZillowUrl } from '../parser/section8';
import { filterProperties, mergeSettings } from '../filter/engine';
import { deduplicateProperties } from '../dedup/normalizer';
import { checkZillowUrl, closeBrowser as closeZillowBrowser } from '../zillow/scraper';
import { checkPropertyAvailability, closeSearchBrowser } from '../availability/checker';
import { calculateUnderwriting } from '../underwriting/calculator';
import { calculateForecastSummary } from '../forecast/projections';
import { rankProperties } from '../ranking/scorer';
import { generateReports, closeBrowser as closeReportBrowser } from '../reports/generator';
import {
    createRun, updateRun, getRun,
    createArtifact,
    saveProperties, saveAnalyses,
    getPropertiesByRunId,
} from '../db/sqlite';
import * as sheets from '../sheets/client';

import type {
    Property, Analysis, Run, Settings,
    UnderwritingInput, ForecastInput
} from '../types';
import type { RankedProperty } from '../ranking/scorer';

export interface PipelineOptions {
    dryRun?: boolean;
    targetStage?: 'extract-only' | 'full';
    settings?: Partial<Settings>;
    onProgress?: (step: string, progress: number, message: string) => void;
    runId?: string;
}

export interface PipelineResult {
    success: boolean;
    runId: string;
    run: Run;
    properties: Property[];
    analyses: Analysis[];
    ranked: RankedProperty[];
    reports?: {
        htmlPath: string;
        pdfPath: string;
    };
    error?: string;
}

/**
 * Run the full analysis pipeline
 */
export async function runPipeline(
    pdfBuffer: Buffer,
    fileName: string,
    options: PipelineOptions = {}
): Promise<PipelineResult> {
    const { dryRun = false, targetStage = 'extract-only', onProgress } = options;
    const settings = mergeSettings(options.settings || {});

    const runId = options.runId || uuidv4();
    const fileHash = computeBufferHash(pdfBuffer);
    const dataDir = path.join(process.cwd(), 'data');
    const runDir = path.join(dataDir, 'runs', runId);
    const chunksDir = path.join(runDir, 'chunks');
    const reportsDir = path.join(runDir, 'reports');

    // Only create run record if we don't already have one (passed via options.runId from upload route)
    if (!options.runId) {
        createRun({
            id: runId,
            fileHash,
            fileName,
            fileSize: pdfBuffer.length,
            dryRun,
        });
    }

    const progress = (step: string, pct: number, msg: string) => {
        updateRun(runId, { currentStep: msg, progress: pct });
        onProgress?.(step, pct, msg);
    };

    try {
        // Ensure directories exist
        await fs.mkdir(chunksDir, { recursive: true });
        await fs.mkdir(reportsDir, { recursive: true });

        // Initialize Google Sheets early for real-time streaming
        let sheetsConnected = false;
        if (process.env.GOOGLE_SPREADSHEET_ID) {
            try {
                const initialized = await sheets.initializeFromEnv();
                sheetsConnected = initialized && sheets.isConnected();
                if (sheetsConnected) {
                    console.log('[Pipeline] Google Sheets connected - will stream properties in real-time');
                    // Record the run in Sheets
                    await sheets.appendRun({
                        id: runId,
                        fileHash,
                        fileName,
                        fileSize: pdfBuffer.length,
                        status: 'extracting',
                        dryRun,
                        createdAt: new Date().toISOString(),
                    });
                }
            } catch (err) {
                console.warn('[Pipeline] Sheets initialization failed, continuing without:', err);
            }
        }

        // Save original PDF
        const originalPath = path.join(runDir, 'original.pdf');
        await fs.writeFile(originalPath, pdfBuffer);
        createArtifact({ runId, type: 'uploaded-pdf', path: originalPath });

        // ========================================================================
        // STEP 1: Split PDF
        // ========================================================================
        progress('splitting', 5, 'Splitting PDF into pages...');
        updateRun(runId, { status: 'splitting', startedAt: new Date().toISOString() });

        const splitResult = await splitPdf(pdfBuffer, {
            pagesPerChunk: 1, // Page by page for accuracy
            maxChunkSizeMB: settings.maxChunkSizeMB,
            outputDir: chunksDir,
            runId,
        });

        updateRun(runId, {
            totalPages: splitResult.totalPages,
            chunksCreated: splitResult.chunks.length,
        });

        for (const chunk of splitResult.chunks) {
            createArtifact({
                runId,
                type: 'chunk-pdf',
                path: chunk.path,
                metadata: { pageStart: chunk.pageStart, pageEnd: chunk.pageEnd },
            });
        }

        // ========================================================================
        // STEP 4: Text Extraction with Sliding Window
        // ========================================================================
        updateRun(runId, { status: 'extracting', currentStep: 'Extracting text from pages' });
        progress('extracting', 15, 'Extracting text from pages...');

        const allProperties: Partial<Property>[] = [];
        const chunks = splitResult.chunks;
        const totalPages = splitResult.totalPages;

        // Check if LLM is enabled - auto-detect if OpenAI API key is available
        const hasOpenAIKey = !!(process.env.OPENAI_API_KEY || settings.llmApiKey);
        const useLLM = settings.enableLLMFallback || settings.llmProvider === 'openai' || hasOpenAIKey;

        console.log(`[Pipeline] OpenAI check: hasKey=${hasOpenAIKey}, envKey=${!!process.env.OPENAI_API_KEY}, settingsKey=${!!settings.llmApiKey}, useLLM=${useLLM}`);

        // Create temp dir for OCR/Image processing
        const tempDir = path.join(runDir, 'temp');
        await fs.mkdir(tempDir, { recursive: true });

        // ================================================================
        // Phase 1: Extract raw text from ALL pages (fast pass)
        // ================================================================
        progress('extracting', 17, 'Extracting text from all pages...');
        const pageTexts: Map<number, string> = new Map();
        const pagesNeedingLLM: number[] = [];

        for (const chunk of chunks) {
            const chunkBuffer = await fs.readFile(chunk.path);
            const hasText = await hasSelectableText(chunkBuffer);

            if (hasText) {
                try {
                    const extracted = await extractTextFromBuffer(chunkBuffer);
                    if (extracted.text.length > 50) {
                        pageTexts.set(chunk.pageStart, extracted.text);
                    }
                } catch (err) {
                    console.error(`[Pipeline] Text extraction failed for page ${chunk.pageStart}:`, err);
                }
            }

            // Track pages without text for potential LLM fallback
            if (!pageTexts.has(chunk.pageStart)) {
                pagesNeedingLLM.push(chunk.pageStart);
            }
        }

        console.log(`[Pipeline] Extracted text from ${pageTexts.size} pages, ${pagesNeedingLLM.length} pages have no selectable text`);

        // ================================================================
        // Phase 2: Parse each page individually (FIRST PASS)
        // This catches properties where all data is on the same page
        // ================================================================
        progress('extracting', 25, 'Parsing properties from pages...');
        const allParsedProperties: Partial<Property>[] = [];
        const pagesWithProperties = new Set<number>();
        let processedCount = 0;

        for (const chunk of chunks) {
            processedCount++;
            const chunkProgress = 25 + (processedCount / chunks.length) * 10; // 25% to 35%
            progress('extracting', chunkProgress, `Parsing page ${chunk.pageStart} of ${totalPages}...`);

            // Skip if this page has no text (will be handled by LLM later)
            if (!pageTexts.has(chunk.pageStart)) continue;

            const currText = pageTexts.get(chunk.pageStart) || '';
            if (currText.trim().length < 100) continue;

            const parseResult = parsePropertiesFromText(currText, runId, {
                sourcePage: chunk.pageStart,
            });

            // Filter to properties that have pricing data
            const pageProps = parseResult.properties.filter(p => p.askingPrice || p.rent);

            if (pageProps.length > 0) {
                pagesWithProperties.add(chunk.pageStart);
                for (const prop of pageProps) {
                    prop.id = uuidv4();
                    prop.runId = runId;
                    prop.status = 'raw';
                    prop.sourcePage = chunk.pageStart;
                    prop.createdAt = new Date().toISOString();
                    prop.updatedAt = new Date().toISOString();
                    allParsedProperties.push(prop);
                }
                console.log(`[Pipeline] Page ${chunk.pageStart}: Found ${pageProps.length} properties`);
            }
        }

        console.log(`[Pipeline] First pass: ${allParsedProperties.length} properties from ${pagesWithProperties.size} pages`);

        // ================================================================
        // Phase 2b: Sliding window fallback for pages with NO properties
        // This catches properties that span page boundaries (URL on prev page)
        // ================================================================
        progress('extracting', 36, 'Checking for page boundary properties...');
        let windowCount = 0;

        for (const chunk of chunks) {
            // Skip if we already found properties on this page
            if (pagesWithProperties.has(chunk.pageStart)) continue;
            if (!pageTexts.has(chunk.pageStart)) continue;

            const prevText = pageTexts.get(chunk.pageStart - 1) || '';
            const currText = pageTexts.get(chunk.pageStart) || '';

            // Only try sliding window if there's previous page text
            if (!prevText) continue;

            const windowText = prevText + '\n\n' + currText;

            const parseResult = parsePropertiesFromText(windowText, runId, {
                sourcePage: chunk.pageStart,
            });

            const pageProps = parseResult.properties.filter(p => p.askingPrice || p.rent);

            // Filter to properties whose pricing data appears in CURRENT page (not previous)
            // This ensures we don't count properties that fully belong to previous page
            for (const prop of pageProps) {
                // Check if this property's pricing appears in current page text
                // Need to handle different price formats: $85k, $85,000, 85000, etc.
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

                const pricingInCurrent = priceMatchesInText(prop.askingPrice, currText) ||
                                          priceMatchesInText(prop.rent, currText);

                if (pricingInCurrent) {
                    // Check if we already have this property (by URL or address)
                    const addrKey = prop.address?.toLowerCase().trim();
                    const urlKey = prop.zillowUrl?.toLowerCase().trim();

                    const isDuplicate = allParsedProperties.some(existing => {
                        const existingAddr = existing.address?.toLowerCase().trim();
                        const existingUrl = existing.zillowUrl?.toLowerCase().trim();
                        return (addrKey && existingAddr === addrKey) ||
                               (urlKey && existingUrl === urlKey);
                    });

                    if (!isDuplicate) {
                        prop.id = uuidv4();
                        prop.runId = runId;
                        prop.status = 'raw';
                        prop.sourcePage = chunk.pageStart;
                        prop.createdAt = new Date().toISOString();
                        prop.updatedAt = new Date().toISOString();
                        const existingNotes = prop.reviewNotes || '';
                        prop.reviewNotes = existingNotes
                            ? `${existingNotes}; From page boundary (URL on prev page)`
                            : 'From page boundary (URL on prev page)';

                        allParsedProperties.push(prop);
                        windowCount++;
                        console.log(`[Pipeline] Page ${chunk.pageStart}: Found boundary property: ${prop.address || 'Unknown'}`);
                    }
                }
            }
        }

        if (windowCount > 0) {
            console.log(`[Pipeline] Sliding window found ${windowCount} additional boundary properties`);
        }

        console.log(`[Pipeline] Total after both passes: ${allParsedProperties.length} properties`);

        // ================================================================
        // Phase 2c: Forward Merge - Find missing askingPrice from NEXT page
        // This handles: Page N has address+rent, Page N+1 has askingPrice
        // ================================================================
        progress('extracting', 37, 'Checking for forward page boundary data...');
        let forwardMergeCount = 0;

        for (const prop of allParsedProperties) {
            // Only process properties that have rent but NO asking price
            if (prop.askingPrice || !prop.rent) continue;
            if (!prop.sourcePage) continue;

            const nextPageNum = prop.sourcePage + 1;
            const nextText = pageTexts.get(nextPageNum);
            if (!nextText) continue;

            // Look for asking price pattern in next page
            const pricePatterns = [
                /asking\s*(?:price)?[:\s]*\$?\s*([\d,]+(?:\.\d+)?)\s*k/i,
                /price[:\s]*\$?\s*([\d,]+(?:\.\d+)?)\s*k/i,
                /\$\s*([\d,]+(?:\.\d+)?)\s*k\b/i,
                /asking\s*(?:price)?[:\s]*\$?\s*([\d,]+)/i,
            ];

            let foundPrice: number | null = null;
            for (const pattern of pricePatterns) {
                const match = nextText.match(pattern);
                if (match) {
                    let priceStr = match[1].replace(/,/g, '');
                    let price = parseFloat(priceStr);

                    // Handle "k" suffix (e.g., "85k" → 85000)
                    if (pattern.source.includes('k') && price < 1000) {
                        price *= 1000;
                    }

                    if (price > 0 && price < 10000000) {  // Sanity check
                        foundPrice = price;
                        break;
                    }
                }
            }

            if (foundPrice) {
                prop.askingPrice = foundPrice;
                const existingNotes = prop.reviewNotes || '';
                prop.reviewNotes = existingNotes
                    ? `${existingNotes}; Asking price merged from page ${nextPageNum}`
                    : `Asking price merged from page ${nextPageNum}`;
                forwardMergeCount++;
                console.log(`[Pipeline] Forward merge: ${prop.address} got askingPrice $${foundPrice.toLocaleString()} from page ${nextPageNum}`);

                // Re-run sanity check since property is now more complete
                if (prop.needsManualReview) {
                    const validation = validatePropertyData(prop);
                    if (!validation.shouldFlag) {
                        // Property is now valid, remove the review flag
                        prop.needsManualReview = false;
                        prop.reviewNotes = existingNotes
                            ? `${existingNotes}; Asking price merged from page ${nextPageNum} (resolved)`
                            : `Asking price merged from page ${nextPageNum}`;
                    }
                }
            }
        }

        if (forwardMergeCount > 0) {
            console.log(`[Pipeline] Forward merge found ${forwardMergeCount} asking prices from next pages`);
        }

        // ================================================================
        // Phase 2d: Deduplicate (should be minimal - only actual duplicates in PDF)
        // ================================================================
        const seenAddresses = new Set<string>();
        const seenUrls = new Set<string>();

        for (const prop of allParsedProperties) {
            const addrKey = prop.address?.toLowerCase().trim();
            const urlKey = prop.zillowUrl?.toLowerCase().trim();

            // Skip if we've already seen this property
            if (addrKey && seenAddresses.has(addrKey)) continue;
            if (urlKey && seenUrls.has(urlKey)) continue;

            // Track for deduplication
            if (addrKey) seenAddresses.add(addrKey);
            if (urlKey) seenUrls.add(urlKey);

            // Run sanity checks
            const validation = validatePropertyData(prop);
            if (validation.shouldFlag) {
                prop.needsManualReview = true;
                const existingNotes = prop.reviewNotes || '';
                prop.reviewNotes = existingNotes
                    ? `${existingNotes}; Sanity: ${validation.issues.join(', ')}`
                    : `Sanity: ${validation.issues.join(', ')}`;
                console.log(`[Pipeline] Property flagged: ${prop.address} - ${validation.issues.join(', ')}`);
            }

            allProperties.push(prop);
        }

        console.log(`[Pipeline] After dedup: ${allProperties.length} unique properties`);

        // ================================================================
        // Phase 2e: Generate page images for flagged properties
        // This allows users to see the original PDF when reviewing
        // ================================================================
        const pagesWithFlaggedProperties = new Set<number>();
        for (const prop of allProperties) {
            if (prop.needsManualReview && prop.sourcePage) {
                pagesWithFlaggedProperties.add(prop.sourcePage);
            }
        }

        if (pagesWithFlaggedProperties.size > 0) {
            console.log(`[Pipeline] Generating images for ${pagesWithFlaggedProperties.size} pages with flagged properties...`);
            progress('extracting', 38, `Generating page images for review...`);

            const imagesDir = path.join(runDir, 'images');
            await fs.mkdir(imagesDir, { recursive: true });

            for (const pageNum of pagesWithFlaggedProperties) {
                // Find the chunk for this page
                const chunk = chunks.find(c => c.pageStart === pageNum);
                if (!chunk) continue;

                // Skip if image already exists (may have been created during LLM phase)
                const permanentPath = path.join(imagesDir, `page_${pageNum}.png`);
                try {
                    await fs.access(permanentPath);
                    console.log(`[Pipeline] Image for page ${pageNum} already exists, skipping`);
                    continue;
                } catch {
                    // File doesn't exist, create it
                }

                try {
                    const imageResult = await pdfPageToImage(chunk.path, 1, imagesDir, { dpi: 150 });
                    if (imageResult.success && imageResult.imagePath) {
                        // Rename to standard naming convention
                        await fs.rename(imageResult.imagePath, permanentPath).catch(async () => {
                            // If rename fails (cross-device), try copy + delete
                            await fs.copyFile(imageResult.imagePath!, permanentPath);
                            await fs.unlink(imageResult.imagePath!).catch(() => {});
                        });

                        // Register as artifact
                        createArtifact({
                            runId,
                            type: 'chunk-image',
                            path: permanentPath,
                            metadata: { pageNumber: pageNum },
                        });

                        console.log(`[Pipeline] Created image for page ${pageNum}`);
                    }
                } catch (err) {
                    console.warn(`[Pipeline] Failed to create image for page ${pageNum}:`, err);
                }
            }
        }

        // Save properties in batch (after dedup)
        if (allProperties.length > 0) {
            saveProperties(allProperties as Property[]);

            // Stream to Google Sheets in real-time (non-blocking)
            if (sheetsConnected) {
                sheets.appendProperties(allProperties).catch(err =>
                    console.warn(`[Pipeline] Sheets append failed:`, err)
                );
            }
        }

        // Update count for real-time UI feedback
        updateRun(runId, {
            propertiesExtracted: allProperties.length,
            currentStep: `Extracted ${allProperties.length} properties`,
        });

        // ================================================================
        // Phase 3: LLM fallback for pages without any selectable text
        // (scanned/image pages only - not for pages where parser found nothing)
        // ================================================================
        if (useLLM && pagesNeedingLLM.length > 0) {
            console.log(`[Pipeline] Running LLM extraction on ${pagesNeedingLLM.length} pages without selectable text...`);

            for (const pageNum of pagesNeedingLLM) {
                const chunk = chunks.find(c => c.pageStart === pageNum);
                if (!chunk) continue;

                const chunkProgress = 40 + ((pagesNeedingLLM.indexOf(pageNum) + 1) / pagesNeedingLLM.length) * 5; // 40% to 45%
                progress('extracting', chunkProgress, `LLM extracting page ${pageNum} of ${totalPages}...`);

                try {
                    // Convert PDF page to image for GPT-4o vision
                    const imageResult = await pdfPageToImage(chunk.path, 1, tempDir);
                    if (imageResult.success && imageResult.imagePath) {
                        const imgBuffer = await fs.readFile(imageResult.imagePath);

                        // Use retry-enabled extraction
                        const { properties } = await extractPropertiesWithRetry(imgBuffer, pageNum);

                        console.log(`[Pipeline] Page ${pageNum}: LLM extracted ${properties.length} properties`);

                        const pageProperties: Partial<Property>[] = [];
                        const flaggedForVerification: Partial<Property>[] = [];

                        for (const prop of properties) {
                            // Deduplicate against already extracted properties
                            const addrKey = prop.address?.toLowerCase().trim();
                            const urlKey = prop.zillowUrl?.toLowerCase().trim();

                            if (addrKey && seenAddresses.has(addrKey)) continue;
                            if (urlKey && seenUrls.has(urlKey)) continue;

                            if (addrKey) seenAddresses.add(addrKey);
                            if (urlKey) seenUrls.add(urlKey);

                            prop.id = uuidv4();
                            prop.runId = runId;
                            prop.status = 'raw';
                            prop.sourcePage = pageNum;
                            prop.createdAt = new Date().toISOString();
                            prop.updatedAt = new Date().toISOString();

                            // Run sanity checks to catch obvious hallucinations
                            const validation = validatePropertyData(prop);
                            if (validation.shouldFlag) {
                                prop.needsManualReview = true;
                                const existingNotes = prop.reviewNotes || '';
                                prop.reviewNotes = existingNotes
                                    ? `${existingNotes}; Sanity: ${validation.issues.join(', ')}`
                                    : `Sanity: ${validation.issues.join(', ')}`;
                                flaggedForVerification.push(prop);
                                console.log(`[Pipeline] Property flagged: ${prop.address} - ${validation.issues.join(', ')}`);
                            }

                            pageProperties.push(prop);
                        }

                        // Post-processing: Fill missing addresses from Zillow URLs
                        for (const prop of pageProperties) {
                            if (!prop.address && prop.zillowUrl) {
                                const extracted = extractAddressFromZillowUrl(prop.zillowUrl);
                                if (extracted.address) {
                                    prop.address = extracted.address;
                                    prop.city = prop.city || extracted.city;
                                    prop.state = prop.state || extracted.state;
                                    prop.zip = prop.zip || extracted.zip;
                                    console.log(`[Pipeline] Extracted address from Zillow URL: ${prop.address}`);
                                }
                            }
                        }

                        // Run verification pass for flagged properties (max 5 to limit API costs)
                        if (flaggedForVerification.length > 0 && flaggedForVerification.length <= 5) {
                            console.log(`[Pipeline] Running verification pass for ${flaggedForVerification.length} flagged properties...`);
                            try {
                                const { corrections } = await verifyExtractedProperties(
                                    flaggedForVerification,
                                    imgBuffer,
                                    pageNum
                                );

                                // Apply corrections
                                for (const correction of corrections) {
                                    const prop = pageProperties.find(p => p.address === correction.address);
                                    if (prop && correction.field && correction.actual !== undefined) {
                                        console.log(`[Pipeline] Correction applied: ${correction.address}.${correction.field}: ${correction.extracted} → ${correction.actual}`);
                                        (prop as Record<string, unknown>)[correction.field] = correction.actual;
                                        prop.reviewNotes = `${prop.reviewNotes || ''}; Corrected: ${correction.reason}`;
                                    }
                                }
                            } catch (verifyErr) {
                                console.error(`[Pipeline] Verification pass failed:`, verifyErr);
                            }
                        }

                        // Save page image for later viewing (helps identify properties with missing addresses)
                        if (imageResult.imagePath) {
                            const imagesDir = path.join(runDir, 'images');
                            await fs.mkdir(imagesDir, { recursive: true });
                            const permanentImagePath = path.join(imagesDir, `page_${pageNum}.png`);
                            const tempPath = imageResult.imagePath;
                            await fs.rename(tempPath, permanentImagePath).catch(async () => {
                                // If rename fails (cross-device), try copy + delete
                                await fs.copyFile(tempPath, permanentImagePath);
                                await fs.unlink(tempPath).catch(() => { });
                            });

                            // Register as artifact
                            createArtifact({
                                runId,
                                type: 'chunk-image',
                                path: permanentImagePath,
                                metadata: { pageNumber: pageNum },
                            });
                        }

                        // Save and update
                        if (pageProperties.length > 0) {
                            allProperties.push(...pageProperties);
                            saveProperties(pageProperties as Property[]);

                            if (sheetsConnected) {
                                sheets.appendProperties(pageProperties).catch(err =>
                                    console.warn(`[Pipeline] Sheets append failed for page ${pageNum}:`, err)
                                );
                            }
                        }

                        updateRun(runId, {
                            propertiesExtracted: allProperties.length,
                            currentStep: `Page ${pageNum}/${totalPages}: LLM found ${pageProperties.length} (${allProperties.length} total)`,
                        });
                    } else {
                        console.error(`[Pipeline] Failed to convert page ${pageNum} to image`);
                        updateRun(runId, {
                            currentStep: `Page ${pageNum}/${totalPages}: Image conversion failed, skipping`,
                        });
                    }
                } catch (err) {
                    console.error(`[Pipeline] LLM extraction failed for page ${pageNum}:`, err);
                    updateRun(runId, {
                        currentStep: `Page ${pageNum}/${totalPages}: Extraction failed, continuing...`,
                    });
                }
            }
        }

        // ================================================================
        // Phase 4: OCR fallback for pages without text and without LLM
        // ================================================================
        if (!useLLM && pagesNeedingLLM.length > 0) {
            console.log(`[Pipeline] Running OCR on ${pagesNeedingLLM.length} pages without selectable text...`);

            for (const pageNum of pagesNeedingLLM) {
                const chunk = chunks.find(c => c.pageStart === pageNum);
                if (!chunk) continue;

                try {
                    const ocrResult = await ocrPdfPage(chunk.path, 1, tempDir);
                    if (ocrResult.success) {
                        const text = normalizeOcrText(ocrResult.text);

                        if (text.length > 50) {
                            const parseResult = parsePropertiesFromText(text, runId, {
                                sourcePage: pageNum,
                            });

                            for (const prop of parseResult.properties) {
                                // Deduplicate
                                const addrKey = prop.address?.toLowerCase().trim();
                                const urlKey = prop.zillowUrl?.toLowerCase().trim();

                                if (addrKey && seenAddresses.has(addrKey)) continue;
                                if (urlKey && seenUrls.has(urlKey)) continue;

                                if (addrKey) seenAddresses.add(addrKey);
                                if (urlKey) seenUrls.add(urlKey);

                                prop.id = uuidv4();
                                prop.runId = runId;
                                prop.status = 'raw';
                                prop.sourcePage = pageNum;
                                prop.createdAt = new Date().toISOString();
                                prop.updatedAt = new Date().toISOString();
                                allProperties.push(prop);
                            }

                            if (parseResult.properties.length > 0) {
                                console.log(`[Pipeline] Page ${pageNum}: OCR+Regex extracted ${parseResult.properties.length} properties`);
                                saveProperties(parseResult.properties as Property[]);
                            }
                        }
                    }
                } catch (ocrErr) {
                    console.error(`[Pipeline] OCR failed for page ${pageNum}:`, ocrErr);
                }
            }
        }

        updateRun(runId, {
            status: 'parsing',
            propertiesExtracted: allProperties.length,
        });

        progress('parsing', 50, `Extracted ${allProperties.length} properties`);

        // ========================================================================
        // STEP 4: Filter Properties
        // ========================================================================
        progress('filtering', 55, 'Applying filters...');
        updateRun(runId, { status: 'filtering' });

        const filterResult = filterProperties(allProperties as Property[], settings);

        updateRun(runId, { propertiesFiltered: filterResult.passed.length });
        progress('filtering', 60, `${filterResult.passed.length} properties passed filters`);

        // ========================================================================
        // STEP 5: Deduplicate
        // ========================================================================
        progress('deduping', 62, 'Deduplicating properties...');
        updateRun(runId, { status: 'deduping' });

        const dedupResult = deduplicateProperties(filterResult.passed);

        updateRun(runId, { propertiesDeduped: dedupResult.unique.length });
        progress('deduping', 65, `${dedupResult.unique.length} unique properties after dedup`);

        // Save both unique and duplicate properties to database
        // Unique properties have status='deduped', duplicates have status='discarded'
        saveProperties(dedupResult.unique);
        if (dedupResult.duplicates.length > 0) {
            saveProperties(dedupResult.duplicates);
        }

        // ========================================================================
        // STEP 6: Check ALL properties for availability (BEFORE review)
        // Only run if marketStatusEnabled is true
        // ========================================================================
        const dedupedProperties = dedupResult.unique;
        let unavailableCount = 0;

        if (settings.marketStatusEnabled) {
            progress('checking-availability', 67, 'Checking property availability...');
            updateRun(runId, { status: 'checking-availability' });

            for (let i = 0; i < dedupedProperties.length; i++) {
                const property = dedupedProperties[i];
                const availProgress = 67 + (i / dedupedProperties.length) * 10;
                progress('checking-availability', availProgress,
                    `Checking ${i + 1}/${dedupedProperties.length}: ${property.address || 'Unknown'}`);

                try {
                    const result = await checkPropertyAvailability(
                        property.zillowUrl,
                        property.address,
                        property.city,
                        property.state
                    );

                    // Update property with availability data
                    property.zillowStatus = result.status;
                    property.zillowLastChecked = result.lastChecked;
                    property.availabilitySource = result.source;
                    property.availabilityDetails = result.details || null;

                    // If we got Zillow data, update additional fields
                    if (result.zillowData) {
                        property.zillowZestimate = result.zillowData.zestimate;
                        if (result.zillowData.beds && !property.bedrooms) property.bedrooms = result.zillowData.beds;
                        if (result.zillowData.baths && !property.bathrooms) property.bathrooms = result.zillowData.baths;
                        if (result.zillowData.sqft && !property.sqft) property.sqft = result.zillowData.sqft;
                        if (result.zillowData.yearBuilt && !property.yearBuilt) property.yearBuilt = result.zillowData.yearBuilt;
                    }

                    // Track unavailable count
                    if (result.status === 'sold' || result.status === 'pending' || result.status === 'off-market') {
                        if (!property.isOffMarketDeal) {
                            unavailableCount++;
                        }
                    }

                    console.log(`[Pipeline] ${property.address}: ${result.status} (source: ${result.source})`);
                } catch (err) {
                    console.error(`[Pipeline] Availability check failed for ${property.address}:`, err);
                    property.zillowStatus = 'needs-review';
                    property.availabilitySource = 'none';
                }
            }

            // Save updated properties with availability data
            saveProperties(dedupedProperties);

            console.log(`[Pipeline] Availability check complete: ${unavailableCount}/${dedupedProperties.length} properties not available`);
            updateRun(runId, {
                propertiesUnavailable: unavailableCount,
                currentStep: `${unavailableCount} of ${dedupedProperties.length} properties not available (sold/pending)`,
            });

            progress('checking-availability', 77, `${unavailableCount} properties not available`);
        } else {
            console.log('[Pipeline] Market status check disabled, skipping...');
            // Clear any previous availability data
            for (const property of dedupedProperties) {
                property.zillowStatus = null;
                property.availabilitySource = null;
            }
            saveProperties(dedupedProperties);
        }

        // Stop if extract-only or dry-run - pause for user review
        if (dryRun || targetStage === 'extract-only') {
            updateRun(runId, {
                status: 'waiting-for-review',
                // completedAt not set yet
            });

            return {
                success: true,
                runId,
                run: getRun(runId)!,
                properties: dedupedProperties,
                analyses: [],
                ranked: [],
            };
        }

        // ========================================================================
        // STEP 7: Filter out unavailable properties before underwriting
        // Only applies if market status checking is enabled
        // ========================================================================
        let propertiesToAnalyze = dedupedProperties;

        if (settings.marketStatusEnabled) {
            const availableProperties = dedupedProperties.filter(p => {
                const status = p.zillowStatus;

                // Always allow off-market deals from PDF (special opportunities)
                if (p.isOffMarketDeal) {
                    console.log(`[Pipeline] ${p.address}: Off-market deal - proceeding to underwriting`);
                    return true;
                }

                // Exclude sold, pending, off-market (unless isOffMarketDeal)
                if (status === 'sold' || status === 'pending' || status === 'off-market') {
                    console.log(`[Pipeline] ${p.address}: Excluded - ${status}`);
                    p.status = 'discarded';
                    p.discardReason = `Property ${status} - not available`;
                    return false;
                }

                // Allow: active, unknown, needs-review, null
                return true;
            });

            const excludedCount = dedupedProperties.length - availableProperties.length;
            console.log(`[Pipeline] ${availableProperties.length} available, ${excludedCount} excluded (sold/pending)`);
            updateRun(runId, { currentStep: `${availableProperties.length} properties available for underwriting` });

            // Save discarded status
            saveProperties(dedupedProperties);

            propertiesToAnalyze = availableProperties;
        }

        // ========================================================================
        // STEP 8 & 9: Underwriting and Forecasts
        // ========================================================================
        progress('underwriting', 75, 'Running underwriting analysis...');
        updateRun(runId, { status: 'underwriting' });

        const analyses: Analysis[] = [];

        for (const property of propertiesToAnalyze) {
            // Skip if missing required data
            if (!property.askingPrice || !property.rent) continue;

            const underwritingInput: UnderwritingInput = {
                purchasePrice: property.suggestedOffer || property.askingPrice,
                rent: property.rent,
                downPaymentPercent: settings.downPaymentPercent,
                closingCostPercent: settings.closingCostPercent,
                interestRate: settings.dscrRate,
                loanTermYears: settings.loanTermYears,
                pmFeePercent: settings.pmFeePercent,
                propertyTaxRate: settings.propertyTaxRate,
                insuranceAnnual: settings.insuranceAnnual,
                vacancyPercent: settings.vacancyEnabled ? settings.vacancyPercent : 0,
                maintenancePercent: settings.maintenanceEnabled ? settings.maintenancePercent : 0,
            };

            const underwriting = calculateUnderwriting(underwritingInput);

            // Run forecast
            const forecastInput: ForecastInput = {
                purchasePrice: underwritingInput.purchasePrice,
                loanAmount: underwriting.loanAmount,
                annualCashflow: underwriting.annualCashflow,
                appreciationPercent: settings.appreciationPercent,
                rentGrowthPercent: settings.rentGrowthPercent,
                expenseInflationPercent: settings.expenseInflationPercent,
                interestRate: settings.dscrRate,
                loanTermYears: settings.loanTermYears,
            };

            const forecast = calculateForecastSummary(forecastInput);

            const analysis: Analysis = {
                id: uuidv4(),
                propertyId: property.id,
                runId,
                purchasePrice: underwritingInput.purchasePrice,
                downPaymentPercent: settings.downPaymentPercent,
                closingCostPercent: settings.closingCostPercent,
                interestRate: settings.dscrRate,
                loanTermYears: settings.loanTermYears,
                pmFeePercent: settings.pmFeePercent,
                vacancyPercent: underwritingInput.vacancyPercent,
                maintenancePercent: underwritingInput.maintenancePercent,
                propertyTaxRate: settings.propertyTaxRate,
                insuranceAnnual: settings.insuranceAnnual,
                ...underwriting,
                monthlyRent: property.rent,
                ...forecast,
                rankScore: 0, // Will be set during ranking
                rank: null,
                createdAt: new Date().toISOString(),
            };

            analyses.push(analysis);
        }

        updateRun(runId, { propertiesAnalyzed: analyses.length });
        progress('forecasting', 85, `Analyzed ${analyses.length} properties`);
        saveAnalyses(analyses);

        // ========================================================================
        // STEP 9: Ranking
        // ========================================================================
        progress('ranking', 87, 'Ranking properties...');
        updateRun(runId, { status: 'ranking' });

        const rankingResult = rankProperties(
            propertiesToAnalyze,
            analyses,
            { topN: settings.topN }
        );

        // Update rank scores in analyses
        for (const ranked of rankingResult.ranked) {
            const analysis = analyses.find(a => a.propertyId === ranked.property.id);
            if (analysis) {
                analysis.rankScore = ranked.score;
                analysis.rank = ranked.rank;
            }
        }

        updateRun(runId, { topNCount: rankingResult.topN.length });

        // ========================================================================
        // STEP 10: Generate Reports
        // ========================================================================
        progress('generating-reports', 90, 'Generating reports...');
        updateRun(runId, { status: 'generating-reports' });

        const reports = await generateReports(
            rankingResult.topN,
            {
                runId,
                fileName,
                date: new Date().toLocaleDateString(),
                totalProperties: allProperties.length,
                filteredCount: filterResult.passed.length,
            },
            reportsDir
        );

        createArtifact({ runId, type: 'report-html', path: reports.htmlPath });
        createArtifact({ runId, type: 'report-pdf', path: reports.pdfPath });

        // ========================================================================
        // Save to Google Sheets (if configured)
        // ========================================================================
        if (settings.sheetsEnabled && sheets.isConnected()) {
            progress('saving', 95, 'Saving to Google Sheets...');

            await sheets.appendRun(getRun(runId)!);
            await sheets.appendProperties(propertiesToAnalyze);
            await sheets.appendAnalysis(analyses);
        }

        // ========================================================================
        // Complete
        // ========================================================================
        updateRun(runId, {
            status: 'completed',
            progress: 100,
            completedAt: new Date().toISOString(),
        });

        progress('completed', 100, 'Pipeline completed successfully!');

        return {
            success: true,
            runId,
            run: getRun(runId)!,
            properties: propertiesToAnalyze,
            analyses,
            ranked: rankingResult.topN,
            reports,
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        updateRun(runId, {
            status: 'failed',
            error: errorMessage,
            completedAt: new Date().toISOString(),
        });

        return {
            success: false,
            runId,
            run: getRun(runId)!,
            properties: [],
            analyses: [],
            ranked: [],
            error: errorMessage,
        };
    }
}

/**
 * Resume the pipeline from the review stage (Analysis Phase)
 */
export async function resumePipeline(
    runId: string,
    options: PipelineOptions = {}
): Promise<PipelineResult> {
    const { onProgress } = options;

    // Merge provided settings with defaults, assuming UI sends full relevant set or partial overrides
    // Ideally we should merge with *existing* run settings but runs don't store settings yet in DB explicitly column-wise
    // For now we'll use passed options + defaults
    const settings = mergeSettings(options.settings || {});

    const progress = (step: string, pct: number, msg: string) => {
        updateRun(runId, { currentStep: msg, progress: pct });
        onProgress?.(step, pct, msg);
    };

    try {
        const run = getRun(runId);
        if (!run) throw new Error(`Run ${runId} not found`);

        const dataDir = path.join(process.cwd(), 'data');
        const runDir = path.join(dataDir, 'runs', runId);
        const reportsDir = path.join(runDir, 'reports');
        await fs.mkdir(reportsDir, { recursive: true });

        // Load properties
        // We need all 'raw' or 'deduped' properties for this run
        const properties = getPropertiesByRunId(runId);

        // We should reset their status to 'deduped' (or similar) to re-filter
        // Or just take all and re-run filter
        // Let's assume 'properties' contains everything saved in Stage 1

        progress('filtering', 55, 'Applying filters...');
        updateRun(runId, { status: 'filtering' });

        const filterResult = filterProperties(properties, settings);

        // Update counts and status
        updateRun(runId, { propertiesFiltered: filterResult.passed.length });

        // Update property statuses in DB
        // Passed -> 'filtered', Failed -> 'discarded'
        // This is expensive if many, but necessary
        // Optimization: only update status if changed? 
        // For now, simpler to just proceed in memory and save analyses. 
        // But persistent status is good.
        // We'll skip massive DB updates for speed unless critical for manual review OF discarded items.

        progress('filtering', 60, `${filterResult.passed.length} properties passed filters`);

        // Skip Zillow check logic copy-paste, ideally extract to function
        // For now, just implement steps 6-10 again

        // ========================================================================
        // STEP 6: Filter out unavailable properties before underwriting
        // (Availability was already checked in Phase 1, if enabled)
        // ========================================================================
        const filteredProperties = filterResult.passed;
        let propertiesToAnalyze = filteredProperties;

        if (settings.marketStatusEnabled) {
            const availableProperties = filteredProperties.filter(p => {
                const status = p.zillowStatus;

                // Always allow off-market deals from PDF (special opportunities)
                if (p.isOffMarketDeal) {
                    console.log(`[Pipeline] ${p.address}: Off-market deal - proceeding to underwriting`);
                    return true;
                }

                // Exclude sold, pending, off-market (unless isOffMarketDeal)
                if (status === 'sold' || status === 'pending' || status === 'off-market') {
                    console.log(`[Pipeline] ${p.address}: Excluded - ${status}`);
                    return false;
                }

                // Allow: active, unknown, needs-review, null
                return true;
            });

            const excludedCount = filteredProperties.length - availableProperties.length;
            console.log(`[Pipeline] ${availableProperties.length} available, ${excludedCount} excluded (sold/pending)`);
            progress('filtering', 70, `${availableProperties.length} properties available for underwriting (${excludedCount} excluded)`);

            propertiesToAnalyze = availableProperties;
        }

        // ========================================================================
        // STEP 7 & 8: Underwriting and Forecasts
        // ========================================================================
        progress('underwriting', 75, 'Running underwriting analysis...');
        updateRun(runId, { status: 'underwriting' });

        const analyses: Analysis[] = [];

        for (const property of propertiesToAnalyze) {
            if (!property.askingPrice || !property.rent) continue;

            const underwritingInput: UnderwritingInput = {
                purchasePrice: property.suggestedOffer || property.askingPrice,
                rent: property.rent,
                downPaymentPercent: settings.downPaymentPercent,
                closingCostPercent: settings.closingCostPercent,
                interestRate: settings.dscrRate,
                loanTermYears: settings.loanTermYears,
                pmFeePercent: settings.pmFeePercent,
                propertyTaxRate: settings.propertyTaxRate,
                insuranceAnnual: settings.insuranceAnnual,
                vacancyPercent: settings.vacancyEnabled ? settings.vacancyPercent : 0,
                maintenancePercent: settings.maintenanceEnabled ? settings.maintenancePercent : 0,
            };

            const underwriting = calculateUnderwriting(underwritingInput);

            const forecastInput: ForecastInput = {
                purchasePrice: underwritingInput.purchasePrice,
                loanAmount: underwriting.loanAmount,
                annualCashflow: underwriting.annualCashflow,
                appreciationPercent: settings.appreciationPercent,
                rentGrowthPercent: settings.rentGrowthPercent,
                expenseInflationPercent: settings.expenseInflationPercent,
                interestRate: settings.dscrRate,
                loanTermYears: settings.loanTermYears,
            };

            const forecast = calculateForecastSummary(forecastInput);

            const analysis: Analysis = {
                id: uuidv4(),
                propertyId: property.id,
                runId,
                purchasePrice: underwritingInput.purchasePrice,
                downPaymentPercent: settings.downPaymentPercent,
                closingCostPercent: settings.closingCostPercent,
                interestRate: settings.dscrRate,
                loanTermYears: settings.loanTermYears,
                pmFeePercent: settings.pmFeePercent,
                vacancyPercent: underwritingInput.vacancyPercent,
                maintenancePercent: underwritingInput.maintenancePercent,
                propertyTaxRate: settings.propertyTaxRate,
                insuranceAnnual: settings.insuranceAnnual,
                ...underwriting,
                monthlyRent: property.rent,
                ...forecast,
                rankScore: 0,
                rank: null,
                createdAt: new Date().toISOString(),
            };

            analyses.push(analysis);
        }

        updateRun(runId, { propertiesAnalyzed: analyses.length });
        progress('forecasting', 85, `Analyzed ${analyses.length} properties`);
        saveAnalyses(analyses);

        // ========================================================================
        // STEP 9: Ranking
        // ========================================================================
        progress('ranking', 87, 'Ranking properties...');
        updateRun(runId, { status: 'ranking' });

        const rankingResult = rankProperties(
            propertiesToAnalyze,
            analyses,
            { topN: settings.topN }
        );

        for (const ranked of rankingResult.ranked) {
            const analysis = analyses.find(a => a.propertyId === ranked.property.id);
            if (analysis) {
                analysis.rankScore = ranked.score;
                analysis.rank = ranked.rank;
            }
        }

        updateRun(runId, { topNCount: rankingResult.topN.length });

        // ========================================================================
        // STEP 10: Generate Reports
        // ========================================================================
        progress('generating-reports', 90, 'Generating reports...');
        updateRun(runId, { status: 'generating-reports' });

        // Re-saving analyses with rank info? saveAnalyses upserts, so yes.
        saveAnalyses(analyses);

        const reports = await generateReports(
            rankingResult.topN,
            {
                runId,
                fileName: run.fileName,
                date: new Date().toLocaleDateString(),
                totalProperties: properties.length,
                filteredCount: filterResult.passed.length,
            },
            reportsDir
        );

        createArtifact({ runId, type: 'report-html', path: reports.htmlPath });
        createArtifact({ runId, type: 'report-pdf', path: reports.pdfPath });

        // ========================================================================
        // Save to Google Sheets (if configured)
        // ========================================================================
        if (settings.sheetsEnabled && sheets.isConnected()) {
            progress('saving', 95, 'Saving to Google Sheets...');
            // We might have already saved run/properties in Step 1?
            // If so, appendAnalysis is new. appendProperties might duplicate if not careful.
            // But Sheets client is append-only usually. 
            // For now, let's just append Analysis.
            await sheets.appendAnalysis(analyses);
        }

        updateRun(runId, {
            status: 'completed',
            progress: 100,
            completedAt: new Date().toISOString(),
        });

        progress('completed', 100, 'Analysis completed successfully!');

        return {
            success: true,
            runId,
            run: getRun(runId)!,
            properties: propertiesToAnalyze,
            analyses,
            ranked: rankingResult.topN,
            reports,
        };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        updateRun(runId, {
            status: 'failed',
            error: errorMessage,
            completedAt: new Date().toISOString(),
        });

        return {
            success: false,
            runId,
            run: getRun(runId)!,
            properties: [],
            analyses: [],
            ranked: [],
            error: errorMessage,
        };
    }
}

/**
 * Cleanup resources (call on shutdown)
 */
export async function cleanup(): Promise<void> {
    await terminateOcrWorker();
    await closeZillowBrowser();
    await closeSearchBrowser();
    await closeReportBrowser();
}
