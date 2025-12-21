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
import { extractPropertiesWithLLM } from '../llm/openai';
import { ocrPdfPage, pdfPageToImage, terminateOcrWorker } from '../ocr/tesseract';
import { parsePropertiesFromText, normalizeOcrText } from '../parser/section8';
import { filterProperties, mergeSettings, getDefaultSettings } from '../filter/engine';
import { deduplicateProperties } from '../dedup/normalizer';
import { checkZillowUrl, closeBrowser as closeZillowBrowser } from '../zillow/scraper';
import { calculateUnderwriting } from '../underwriting/calculator';
import { calculateForecastSummary } from '../forecast/projections';
import { rankProperties } from '../ranking/scorer';
import { generateReports, closeBrowser as closeReportBrowser } from '../reports/generator';
import {
    createRun, updateRun, getRun,
    createArtifact, listArtifacts,
    saveProperties, saveAnalyses,
    getPropertiesByRunId,
} from '../db/sqlite';
import * as sheets from '../sheets/client';

import type {
    Property, Analysis, Run, Settings,
    ChunkInfo, UnderwritingInput, ForecastInput
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

    // Create run record
    const run = createRun({
        id: runId,
        fileHash,
        fileName,
        fileSize: pdfBuffer.length,
        dryRun,
    });

    const progress = (step: string, pct: number, msg: string) => {
        updateRun(runId, { currentStep: step, progress: pct });
        onProgress?.(step, pct, msg);
    };

    try {
        // Ensure directories exist
        await fs.mkdir(chunksDir, { recursive: true });
        await fs.mkdir(reportsDir, { recursive: true });

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
        // STEP 4: Text Extraction / OCR / LLM
        // ========================================================================
        updateRun(runId, { status: 'extracting', currentStep: 'Extracting text from pages' });
        progress('extracting', 15, 'Extracting text from pages...');

        let processedCount = 0;
        const allProperties: Partial<Property>[] = [];
        const chunks = splitResult.chunks; // Use splitResult.chunks
        const totalPages = splitResult.totalPages; // Use splitResult.totalPages

        // Check if LLM is enabled
        const useLLM = settings.enableLLMFallback || settings.llmProvider === 'openai';

        // Create temp dir for OCR/Image processing
        const tempDir = path.join(runDir, 'temp');
        await fs.mkdir(tempDir, { recursive: true });

        for (const chunk of chunks) {
            processedCount++;
            const chunkProgress = 15 + (processedCount / chunks.length) * 30; // 15% to 45%
            progress('extracting', chunkProgress, `Processing page ${chunk.pageStart} of ${totalPages}...`);

            const chunkBuffer = await fs.readFile(chunk.path);

            if (useLLM) {
                try {
                    // Convert first page of chunk to image (assuming 1 page per chunk for now)
                    // If chunk has multiple pages, we might need to iterate.
                    // Current splitter does 1 page per chunk if not specified,
                    // but settings.chunkSizePages defaults to 5.
                    // For LLM, we should process page by page.
                    // But wait, the splitter made chunks.

                    // We need to render the PDF chunk to images.
                    // Since chunk is a valid PDF, we can render page 1 of it.
                    // Let's use pdfPageToImage directly
                    const imageResult = await pdfPageToImage(chunk.path, 1, tempDir);
                    if (imageResult.success && imageResult.imagePath) {
                        const imgBuffer = await fs.readFile(imageResult.imagePath);
                        const { properties } = await extractPropertiesWithLLM(imgBuffer, chunk.pageStart);
                        allProperties.push(...properties);

                        // Cleanup
                        await fs.unlink(imageResult.imagePath).catch(() => { });
                    } else {
                        console.error(`Failed to convert chunk ${chunk.id} to image for LLM`);
                    }

                } catch (err) {
                    console.error('LLM extraction failed:', err);
                    // Fallback?
                }
                continue; // Skip standard path
            }

            // Standard Path (Text/OCR + Regex)
            let text = '';
            const hasText = await hasSelectableText(chunkBuffer);

            if (hasText) {
                const extracted = await extractTextFromBuffer(chunkBuffer);
                text = extracted.text;
            } else {
                // Fall back to OCR
                const ocrResult = await ocrPdfPage(chunk.path, 1, tempDir);
                if (ocrResult.success) {
                    text = normalizeOcrText(ocrResult.text);
                }
            }

            if (text.length > 50) {
                const parseResult = parsePropertiesFromText(text, runId, {
                    sourcePage: chunk.pageStart,
                });

                allProperties.push(...parseResult.properties);
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
        saveProperties(dedupResult.unique);

        // Stop if extract-only or dry-run
        if (dryRun || targetStage === 'extract-only') {
            updateRun(runId, {
                status: 'waiting-for-review',
                // completedAt not set yet
            });

            return {
                success: true,
                runId,
                run: getRun(runId)!,
                properties: dedupResult.unique,
                analyses: [],
                ranked: [],
            };
        }

        // ========================================================================
        // STEP 6: Zillow Checks (optional, slow)
        // ========================================================================
        const propertiesToAnalyze = dedupResult.unique;

        if (propertiesToAnalyze.some(p => p.zillowUrl && !p.zillowStatus)) {
            progress('checking-zillow', 67, 'Checking Zillow status...');
            updateRun(runId, { status: 'checking-zillow' });

            for (let i = 0; i < propertiesToAnalyze.length; i++) {
                const property = propertiesToAnalyze[i];

                if (property.zillowUrl && !property.zillowStatus) {
                    const zillowProgress = 67 + (i / propertiesToAnalyze.length) * 8;
                    progress('checking-zillow', zillowProgress, `Checking Zillow ${i + 1}/${propertiesToAnalyze.length}...`);

                    try {
                        const result = await checkZillowUrl(property.zillowUrl);
                        property.zillowStatus = result.status;
                        property.zillowZestimate = result.zestimate;
                        property.zillowLastChecked = result.lastUpdated;

                        // Update beds/baths if we got them from Zillow
                        if (result.beds && !property.bedrooms) property.bedrooms = result.beds;
                        if (result.baths && !property.bathrooms) property.bathrooms = result.baths;
                        if (result.sqft && !property.sqft) property.sqft = result.sqft;
                        if (result.yearBuilt && !property.yearBuilt) property.yearBuilt = result.yearBuilt;
                    } catch {
                        property.zillowStatus = 'needs-review';
                    }
                }
            }
        }

        // ========================================================================
        // STEP 7 & 8: Underwriting and Forecasts
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
        updateRun(runId, { currentStep: step, progress: pct });
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
        // STEP 6: Zillow Checks
        // ========================================================================
        const propertiesToAnalyze = filterResult.passed;

        if (propertiesToAnalyze.some(p => p.zillowUrl && !p.zillowStatus)) {
            progress('checking-zillow', 67, 'Checking Zillow status...');
            updateRun(runId, { status: 'checking-zillow' });

            for (let i = 0; i < propertiesToAnalyze.length; i++) {
                const property = propertiesToAnalyze[i];

                if (property.zillowUrl && !property.zillowStatus) {
                    const zillowProgress = 67 + (i / propertiesToAnalyze.length) * 8;
                    progress('checking-zillow', zillowProgress, `Checking Zillow ${i + 1}/${propertiesToAnalyze.length}...`);

                    try {
                        const result = await checkZillowUrl(property.zillowUrl);
                        property.zillowStatus = result.status;
                        property.zillowZestimate = result.zestimate;
                        property.zillowLastChecked = result.lastUpdated;

                        // Update in DB too so we don't re-check next time?
                        // Yes, updateProperty(property.id, ...)
                        // Update beds/baths if we got them from Zillow
                        if (result.beds && !property.bedrooms) property.bedrooms = result.beds;
                        if (result.baths && !property.bathrooms) property.bathrooms = result.baths;
                        if (result.sqft && !property.sqft) property.sqft = result.sqft;
                        if (result.yearBuilt && !property.yearBuilt) property.yearBuilt = result.yearBuilt;

                        // Persist Zillow updates
                        // updateProperty(property.id, { ... }); // Needed? Yes.
                    } catch {
                        property.zillowStatus = 'needs-review';
                    }
                }
            }
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
    await closeReportBrowser();
}
