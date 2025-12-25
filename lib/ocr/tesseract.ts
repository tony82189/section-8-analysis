import Tesseract from 'tesseract.js';
import * as fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface OcrResult {
    success: boolean;
    text: string;
    confidence: number;
    words: OcrWord[];
    processingTime: number;
    error?: string;
}

export interface OcrWord {
    text: string;
    confidence: number;
    bbox: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
}

// Singleton worker for better performance (reuses trained data)
let worker: Tesseract.Worker | null = null;

/**
 * Get or create the Tesseract worker
 */
async function getWorker(): Promise<Tesseract.Worker> {
    if (!worker) {
        worker = await Tesseract.createWorker('eng', 1, {
            // Use local cache for language data
            cachePath: path.join(process.cwd(), 'data', 'tesseract-cache'),
        });
    }
    return worker;
}

/**
 * Terminate the Tesseract worker (call on shutdown)
 */
export async function terminateOcrWorker(): Promise<void> {
    if (worker) {
        await worker.terminate();
        worker = null;
    }
}

/**
 * Perform OCR on an image buffer
 */
export async function ocrFromBuffer(
    imageBuffer: Buffer,
    options: { lang?: string } = {}
): Promise<OcrResult> {
    const startTime = Date.now();

    try {
        const ocrWorker = await getWorker();
        const result = await ocrWorker.recognize(imageBuffer);

        const data = (result.data || {}) as any;
        const words: OcrWord[] = (data.words || []).map((word: any) => ({
            text: word.text,
            confidence: word.confidence,
            bbox: word.bbox,
        }));

        return {
            success: true,
            text: data.text || '',
            confidence: data.confidence || 0,
            words,
            processingTime: Date.now() - startTime,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            text: '',
            confidence: 0,
            words: [],
            processingTime: Date.now() - startTime,
            error: message,
        };
    }
}

/**
 * Perform OCR on an image file
 */
export async function ocrFromFile(
    imagePath: string,
    options: { lang?: string } = {}
): Promise<OcrResult> {
    try {
        const buffer = await fs.readFile(imagePath);
        return ocrFromBuffer(buffer, options);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            text: '',
            confidence: 0,
            words: [],
            processingTime: 0,
            error: `Failed to read file: ${message}`,
        };
    }
}

// Common paths where pdftoppm might be installed
const PDFTOPPM_PATHS = [
    '/opt/homebrew/bin/pdftoppm', // Homebrew on Apple Silicon (check first - most likely)
    '/opt/homebrew/Cellar/poppler/25.12.0/bin/pdftoppm', // Direct Cellar path
    '/usr/local/bin/pdftoppm', // Homebrew on Intel Mac
    '/usr/bin/pdftoppm', // Linux system install
    'pdftoppm', // Try PATH last
];

const CONVERT_PATHS = [
    '/opt/homebrew/bin/convert', // Homebrew on Apple Silicon
    '/usr/local/bin/convert', // Homebrew on Intel Mac
    '/usr/bin/convert', // Linux system install
    'convert', // Try PATH last
];

/**
 * Find the first available command from a list of paths
 */
async function findCommand(paths: string[]): Promise<string | null> {
    for (const cmdPath of paths) {
        try {
            // Check if the command exists by checking the file
            if (cmdPath.startsWith('/')) {
                await fs.access(cmdPath);
                return cmdPath;
            }
            // For commands in PATH, try `which`
            await execAsync(`which ${cmdPath}`, { timeout: 2000 });
            return cmdPath;
        } catch {
            // Try next path
        }
    }
    return null;
}

/**
 * Convert a PDF page to an image using ImageMagick/GraphicsMagick or pdftoppm
 * Returns the path to the generated image
 */
export async function pdfPageToImage(
    pdfPath: string,
    pageNumber: number,
    outputDir: string,
    options: { dpi?: number; format?: 'png' | 'jpeg' } = {}
): Promise<{ success: boolean; imagePath?: string; error?: string }> {
    const { dpi = 300, format = 'png' } = options;
    const outputPath = path.join(outputDir, `page_${pageNumber}.${format}`);

    try {
        // Ensure output directory exists
        await fs.mkdir(outputDir, { recursive: true });

        // Try pdftoppm first (usually available on Linux/Mac with poppler-utils)
        const pdftoppmCmd = await findCommand(PDFTOPPM_PATHS);
        if (pdftoppmCmd) {
            try {
                const pageArg = pageNumber.toString();
                const outputBase = outputPath.replace(`.${format}`, '');
                const cmd = `"${pdftoppmCmd}" -${format} -r ${dpi} -f ${pageArg} -l ${pageArg} -singlefile "${pdfPath}" "${outputBase}"`;
                await execAsync(cmd);

                // pdftoppm adds its own extension
                await fs.access(outputPath);
                return { success: true, imagePath: outputPath };
            } catch (err) {
                console.error(`pdftoppm failed:`, err);
                // Fall through to try convert
            }
        }

        // Try convert (ImageMagick)
        const convertCmd = await findCommand(CONVERT_PATHS);
        if (convertCmd) {
            try {
                await execAsync(
                    `"${convertCmd}" -density ${dpi} "${pdfPath}[${pageNumber - 1}]" -quality 100 "${outputPath}"`
                );
                await fs.access(outputPath);
                return { success: true, imagePath: outputPath };
            } catch (err) {
                console.error(`convert failed:`, err);
            }
        }

        return {
            success: false,
            error: 'No PDF to image converter available (install poppler-utils or ImageMagick)',
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
    }
}

/**
 * OCR a PDF page by converting to image first
 */
export async function ocrPdfPage(
    pdfPath: string,
    pageNumber: number,
    tempDir: string
): Promise<OcrResult> {
    // Convert PDF page to image
    const imageResult = await pdfPageToImage(pdfPath, pageNumber, tempDir);

    if (!imageResult.success || !imageResult.imagePath) {
        return {
            success: false,
            text: '',
            confidence: 0,
            words: [],
            processingTime: 0,
            error: imageResult.error || 'Failed to convert PDF page to image',
        };
    }

    try {
        // Perform OCR on the image
        const ocrResult = await ocrFromFile(imageResult.imagePath);

        // Clean up the temporary image
        try {
            await fs.unlink(imageResult.imagePath);
        } catch {
            // Ignore cleanup errors
        }

        return ocrResult;
    } catch (err) {
        // Clean up on error too
        try {
            await fs.unlink(imageResult.imagePath);
        } catch {
            // Ignore
        }

        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            text: '',
            confidence: 0,
            words: [],
            processingTime: 0,
            error: message,
        };
    }
}

/**
 * Batch OCR multiple pages from a PDF
 */
export async function ocrPdfPages(
    pdfPath: string,
    pageNumbers: number[],
    tempDir: string,
    onProgress?: (page: number, total: number) => void
): Promise<Map<number, OcrResult>> {
    const results = new Map<number, OcrResult>();

    for (let i = 0; i < pageNumbers.length; i++) {
        const pageNum = pageNumbers[i];
        onProgress?.(i + 1, pageNumbers.length);

        const result = await ocrPdfPage(pdfPath, pageNum, tempDir);
        results.set(pageNum, result);
    }

    return results;
}

/**
 * Clean OCR text output
 */
export function cleanOcrText(text: string): string {
    return text
        // Fix common OCR errors
        .replace(/[|]/g, 'I') // Pipe often misread as I
        .replace(/0(?=[a-zA-Z])/g, 'O') // Zero before letter often should be O
        .replace(/1(?=[a-zA-Z])/g, 'l') // One before letter often should be l
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        // Remove stray single characters that are likely noise
        .replace(/\s[^aAI]\s/g, ' ')
        // Fix double spaces
        .replace(/  +/g, ' ')
        .trim();
}
