import { PDFDocument } from 'pdf-lib';
import * as fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import type { ChunkInfo } from '../types';

export interface SplitOptions {
    /** Number of pages per chunk (default: 1 for page-by-page) */
    pagesPerChunk?: number;
    /** Maximum size per chunk in MB (default: 10) */
    maxChunkSizeMB?: number;
    /** Output directory for chunks */
    outputDir: string;
    /** Run ID for tracking */
    runId: string;
}

export interface SplitResult {
    success: boolean;
    totalPages: number;
    chunks: ChunkInfo[];
    errors: string[];
}

/**
 * Compute SHA-256 hash of a file
 */
export async function computeFileHash(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Compute SHA-256 hash of a buffer
 */
export function computeBufferHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Split a PDF into smaller chunks
 * 
 * Strategy:
 * 1. If pagesPerChunk > 1, split into groups of N pages
 * 2. Always enforce maxChunkSizeMB - if a chunk exceeds this, split further
 * 3. For single-page mode (default), each page becomes its own chunk
 */
export async function splitPdf(
    pdfBuffer: Buffer,
    options: SplitOptions
): Promise<SplitResult> {
    const {
        pagesPerChunk = 1,
        maxChunkSizeMB = 10,
        outputDir,
        runId,
    } = options;

    const maxChunkBytes = maxChunkSizeMB * 1024 * 1024;
    const chunks: ChunkInfo[] = [];
    const errors: string[] = [];

    try {
        // Ensure output directory exists
        await fs.mkdir(outputDir, { recursive: true });

        // Load the source PDF
        const srcDoc = await PDFDocument.load(pdfBuffer);
        const totalPages = srcDoc.getPageCount();

        if (totalPages === 0) {
            return {
                success: false,
                totalPages: 0,
                chunks: [],
                errors: ['PDF has no pages'],
            };
        }

        // Calculate page ranges
        const pageRanges: Array<{ start: number; end: number }> = [];
        for (let i = 0; i < totalPages; i += pagesPerChunk) {
            pageRanges.push({
                start: i,
                end: Math.min(i + pagesPerChunk - 1, totalPages - 1),
            });
        }

        // Process each range
        for (const range of pageRanges) {
            try {
                const chunkId = uuidv4();
                const pageIndices = Array.from(
                    { length: range.end - range.start + 1 },
                    (_, i) => range.start + i
                );

                // Create new PDF with selected pages
                const chunkDoc = await PDFDocument.create();
                const pages = await chunkDoc.copyPages(srcDoc, pageIndices);
                pages.forEach(page => chunkDoc.addPage(page));

                const chunkBytes = await chunkDoc.save();
                const chunkSize = chunkBytes.length;

                // Check if chunk exceeds size limit
                if (chunkSize > maxChunkBytes && pageIndices.length > 1) {
                    // Need to split this chunk further - split each page individually
                    for (const pageIndex of pageIndices) {
                        const singleChunkId = uuidv4();
                        const singleDoc = await PDFDocument.create();
                        const [singlePage] = await singleDoc.copyPages(srcDoc, [pageIndex]);
                        singleDoc.addPage(singlePage);

                        const singleBytes = await singleDoc.save();
                        const singleSize = singleBytes.length;

                        // Even single page exceeds limit - still save but warn
                        if (singleSize > maxChunkBytes) {
                            errors.push(
                                `Page ${pageIndex + 1} exceeds max chunk size (${(singleSize / 1024 / 1024).toFixed(2)}MB > ${maxChunkSizeMB}MB)`
                            );
                        }

                        const singlePath = path.join(outputDir, `chunk_${singleChunkId}.pdf`);
                        await fs.writeFile(singlePath, singleBytes);

                        chunks.push({
                            id: singleChunkId,
                            runId,
                            pageStart: pageIndex + 1, // 1-indexed for users
                            pageEnd: pageIndex + 1,
                            path: singlePath,
                            size: singleSize,
                            hasText: false, // Will be determined by extractor
                        });
                    }
                } else {
                    // Chunk is within size limit
                    const chunkPath = path.join(outputDir, `chunk_${chunkId}.pdf`);
                    await fs.writeFile(chunkPath, chunkBytes);

                    chunks.push({
                        id: chunkId,
                        runId,
                        pageStart: range.start + 1, // 1-indexed for users
                        pageEnd: range.end + 1,
                        path: chunkPath,
                        size: chunkSize,
                        hasText: false, // Will be determined by extractor
                    });
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                errors.push(`Error processing pages ${range.start + 1}-${range.end + 1}: ${message}`);
            }
        }

        return {
            success: errors.length === 0,
            totalPages,
            chunks,
            errors,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            totalPages: 0,
            chunks: [],
            errors: [`Failed to load PDF: ${message}`],
        };
    }
}

/**
 * Get PDF page count without loading the full document
 */
export async function getPdfPageCount(pdfBuffer: Buffer): Promise<number> {
    const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    return doc.getPageCount();
}

/**
 * Extract a range of pages from a PDF
 */
export async function extractPages(
    pdfBuffer: Buffer,
    startPage: number,
    endPage: number
): Promise<Buffer> {
    const srcDoc = await PDFDocument.load(pdfBuffer);
    const newDoc = await PDFDocument.create();

    const pageIndices = Array.from(
        { length: endPage - startPage + 1 },
        (_, i) => startPage + i
    );

    const pages = await newDoc.copyPages(srcDoc, pageIndices);
    pages.forEach(page => newDoc.addPage(page));

    const bytes = await newDoc.save();
    return Buffer.from(bytes);
}

/**
 * Merge multiple PDF buffers into one
 */
export async function mergePdfs(pdfBuffers: Buffer[]): Promise<Buffer> {
    const mergedDoc = await PDFDocument.create();

    for (const buffer of pdfBuffers) {
        const srcDoc = await PDFDocument.load(buffer);
        const pageIndices = srcDoc.getPageIndices();
        const pages = await mergedDoc.copyPages(srcDoc, pageIndices);
        pages.forEach(page => mergedDoc.addPage(page));
    }

    const bytes = await mergedDoc.save();
    return Buffer.from(bytes);
}

/**
 * Get file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
