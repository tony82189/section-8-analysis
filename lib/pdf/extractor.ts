// Polyfill for pdf-parse in Node environment
if (typeof Promise.withResolvers === 'undefined') {
    // @ts-ignore
    Promise.withResolvers = function () {
        let resolve, reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    };
}

if (!global.DOMMatrix) {
    // @ts-ignore
    global.DOMMatrix = class DOMMatrix {
        constructor() { }
        translate() { return this; }
        scale() { return this; }
        rotate() { return this; }
        multiply() { return this; }
    };
}

if (!global.Path2D) {
    // @ts-ignore
    global.Path2D = class Path2D {
        constructor() { }
    };
}

if (!global.ImageData) {
    // @ts-ignore
    global.ImageData = class ImageData {
        constructor() { }
    };
}

const pdfParse = require('pdf-parse');
import * as fs from 'fs/promises';

export interface TextExtractionResult {
    success: boolean;
    text: string;
    pageCount: number;
    hasSelectableText: boolean;
    textLength: number;
    metadata: {
        title?: string;
        author?: string;
        creator?: string;
        producer?: string;
    };
    error?: string;
}

/**
 * Extract text from a PDF buffer using pdf-parse
 * This works for PDFs with selectable text (not scanned images)
 */
export async function extractTextFromBuffer(
    pdfBuffer: Buffer
): Promise<TextExtractionResult> {
    try {
        const data = await pdfParse(pdfBuffer, {
            // Limit max pages to prevent memory issues
            max: 500,
        });

        const text = data.text || '';
        const hasSelectableText = text.trim().length > 50; // Threshold for "has meaningful text"

        return {
            success: true,
            text: text.trim(),
            pageCount: data.numpages,
            hasSelectableText,
            textLength: text.length,
            metadata: {
                title: data.info?.Title,
                author: data.info?.Author,
                creator: data.info?.Creator,
                producer: data.info?.Producer,
            },
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            text: '',
            pageCount: 0,
            hasSelectableText: false,
            textLength: 0,
            metadata: {},
            error: message,
        };
    }
}

/**
 * Extract text from a PDF file path
 */
export async function extractTextFromFile(
    filePath: string
): Promise<TextExtractionResult> {
    try {
        const buffer = await fs.readFile(filePath);
        return extractTextFromBuffer(buffer);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            text: '',
            pageCount: 0,
            hasSelectableText: false,
            textLength: 0,
            metadata: {},
            error: `Failed to read file: ${message}`,
        };
    }
}

/**
 * Check if a PDF has selectable text (without extracting all of it)
 * This is useful for quickly determining if OCR is needed
 */
export async function hasSelectableText(pdfBuffer: Buffer): Promise<boolean> {
    try {
        // Only parse first few pages for speed
        const data = await pdfParse(pdfBuffer, { max: 3 });
        const text = data.text || '';

        // Check if there's meaningful text content
        // Threshold: at least 50 chars and some words (not just symbols/whitespace)
        const cleanText = text.replace(/\s+/g, ' ').trim();
        const wordPattern = /[a-zA-Z]{2,}/g;
        const words = cleanText.match(wordPattern) || [];

        return cleanText.length > 50 && words.length > 5;
    } catch {
        return false;
    }
}

/**
 * Extract text page by page from a PDF
 * Note: pdf-parse doesn't support true page-by-page extraction,
 * so we return the full text with page markers inserted where detectable
 */
export async function extractTextByPage(
    pdfBuffer: Buffer
): Promise<{ pageTexts: string[]; success: boolean; error?: string }> {
    try {
        const data = await pdfParse(pdfBuffer);

        // pdf-parse doesn't give us page boundaries directly
        // We can try to split by form feed characters or page markers
        const text = data.text || '';

        // Try to split by form feed character (sometimes present)
        let pages = text.split('\f');

        // If no form feeds, return text as single page
        if (pages.length === 1 || (pages.length < data.numpages && data.numpages > 1)) {
            // Return as a single block per page estimate
            pages = [text];
        }

        return {
            pageTexts: pages.map((p: string) => p.trim()).filter((p: string) => p.length > 0),
            success: true,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            pageTexts: [],
            success: false,
            error: message,
        };
    }
}

/**
 * Clean and normalize extracted text for parsing
 */
export function normalizeText(text: string): string {
    return text
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        // Remove control characters
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Normalize quotes
        .replace(/[""]/g, '"')
        .replace(/['']/g, "'")
        // Normalize dashes
        .replace(/[–—]/g, '-')
        // Trim
        .trim();
}

/**
 * Split text into logical records/blocks
 * Useful for Section 8 property listings that are formatted as records
 */
export function splitIntoRecords(
    text: string,
    delimiter: RegExp = /(?=(?:Property|Address|Listing|#?\d+\s*[-–]\s*\d+|^\d{1,5}\s+[A-Z]))/gim
): string[] {
    const normalized = normalizeText(text);
    const records = normalized.split(delimiter);

    return records
        .map(r => r.trim())
        .filter(r => r.length > 50); // Filter out tiny fragments
}
