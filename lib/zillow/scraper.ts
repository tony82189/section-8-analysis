/**
 * Zillow Scraper
 * 
 * Uses Playwright to scrape property status and details from Zillow.
 * Includes rate limiting, retry logic, and fallback handling.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import type { ZillowResult } from '../types';

// Rate limiting settings
const MIN_DELAY_MS = 5000;
const MAX_DELAY_MS = 15000;
const MAX_RETRIES = 3;

// Browser instance (singleton for efficiency)
let browser: Browser | null = null;

/**
 * Get or create browser instance
 */
async function getBrowser(): Promise<Browser> {
    if (!browser) {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
            ],
        });
    }
    return browser;
}

/**
 * Close browser instance (call on shutdown)
 */
export async function closeBrowser(): Promise<void> {
    if (browser) {
        await browser.close();
        browser = null;
    }
}

/**
 * Create a new browser context with randomized fingerprint
 */
async function createContext(): Promise<BrowserContext> {
    const b = await getBrowser();

    const userAgents = [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    ];

    const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];

    return b.newContext({
        userAgent: randomUA,
        viewport: { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 200) },
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });
}

/**
 * Random delay to mimic human behavior
 */
function randomDelay(): Promise<void> {
    const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Check a single Zillow URL
 */
export async function checkZillowUrl(url: string): Promise<ZillowResult> {
    const result: ZillowResult = {
        url,
        status: 'unknown',
        zestimate: null,
        beds: null,
        baths: null,
        sqft: null,
        yearBuilt: null,
        lastUpdated: new Date().toISOString(),
    };

    let context: BrowserContext | null = null;
    let page: Page | null = null;
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Add delay before each attempt
            if (attempt > 1) {
                await randomDelay();
            }

            context = await createContext();
            page = await context.newPage();

            // Navigate to the Zillow URL
            const response = await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });

            if (!response) {
                throw new Error('No response from Zillow');
            }

            const status = response.status();

            // Check for blocking/captcha
            if (status === 403 || status === 429) {
                lastError = `Blocked by Zillow (status ${status})`;
                continue;
            }

            if (status === 404) {
                result.status = 'off-market';
                return result;
            }

            if (status !== 200) {
                lastError = `Unexpected status code: ${status}`;
                continue;
            }

            // Wait for content to load
            await page.waitForTimeout(2000);

            // Check for captcha
            const captcha = await page.$('[class*="captcha"], [id*="captcha"], .px-captcha');
            if (captcha) {
                lastError = 'Captcha detected';
                continue;
            }

            // Extract property status
            result.status = await extractStatus(page);

            // Extract property details
            const details = await extractDetails(page);
            result.zestimate = details.zestimate;
            result.beds = details.beds;
            result.baths = details.baths;
            result.sqft = details.sqft;
            result.yearBuilt = details.yearBuilt;

            return result;

        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
        } finally {
            if (page) await page.close().catch(() => { });
            if (context) await context.close().catch(() => { });
        }
    }

    // All retries failed
    result.status = 'needs-review';
    result.error = lastError;
    return result;
}

/**
 * Extract property status from page
 */
async function extractStatus(page: Page): Promise<ZillowResult['status']> {
    try {
        // Check for various status indicators
        const pageContent = await page.content();
        const contentLower = pageContent.toLowerCase();

        // Check for off-market indicators
        if (
            contentLower.includes('off market') ||
            contentLower.includes('this home is not currently listed') ||
            contentLower.includes('no longer available')
        ) {
            return 'off-market';
        }

        // Check for sold status
        if (
            contentLower.includes('sold on') ||
            contentLower.includes('sold -') ||
            contentLower.includes('status: sold')
        ) {
            return 'sold';
        }

        // Check for pending status
        if (
            contentLower.includes('pending') ||
            contentLower.includes('under contract') ||
            contentLower.includes('contingent')
        ) {
            return 'pending';
        }

        // Check for active/for sale status
        if (
            contentLower.includes('for sale') ||
            contentLower.includes('active listing') ||
            contentLower.includes('list price')
        ) {
            return 'active';
        }

        // Try to find explicit status element
        const statusElement = await page.$('[data-testid="home-details-chip-status"], .ds-status-details');
        if (statusElement) {
            const statusText = await statusElement.textContent();
            if (statusText) {
                const status = statusText.toLowerCase();
                if (status.includes('sold')) return 'sold';
                if (status.includes('pending')) return 'pending';
                if (status.includes('sale')) return 'active';
                if (status.includes('off')) return 'off-market';
            }
        }

        return 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Extract property details from page
 */
async function extractDetails(page: Page): Promise<{
    zestimate: number | null;
    beds: number | null;
    baths: number | null;
    sqft: number | null;
    yearBuilt: number | null;
}> {
    const details = {
        zestimate: null as number | null,
        beds: null as number | null,
        baths: null as number | null,
        sqft: null as number | null,
        yearBuilt: null as number | null,
    };

    try {
        // Extract Zestimate
        const zestimateEl = await page.$('[data-testid="zestimate-value"], .ds-home-fact-list-item:has-text("Zestimate")');
        if (zestimateEl) {
            const text = await zestimateEl.textContent();
            if (text) {
                const match = text.match(/\$[\d,]+/);
                if (match) {
                    details.zestimate = parseInt(match[0].replace(/[$,]/g, ''), 10);
                }
            }
        }

        // Extract beds/baths/sqft from summary
        const summaryEl = await page.$('[data-testid="bed-bath-beyond"], .ds-bed-bath-living-area');
        if (summaryEl) {
            const text = await summaryEl.textContent();
            if (text) {
                // Parse beds
                const bedsMatch = text.match(/(\d+)\s*(?:bd|bed|bedroom)/i);
                if (bedsMatch) details.beds = parseInt(bedsMatch[1], 10);

                // Parse baths
                const bathsMatch = text.match(/([\d.]+)\s*(?:ba|bath)/i);
                if (bathsMatch) details.baths = parseFloat(bathsMatch[1]);

                // Parse sqft
                const sqftMatch = text.match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft)/i);
                if (sqftMatch) details.sqft = parseInt(sqftMatch[1].replace(/,/g, ''), 10);
            }
        }

        // Extract year built from facts
        const factsEls = await page.$$('[data-testid="facts-table"] tr, .ds-home-fact-list-item');
        for (const factEl of factsEls) {
            const text = await factEl.textContent();
            if (text && text.toLowerCase().includes('year built')) {
                const yearMatch = text.match(/\b(19|20)\d{2}\b/);
                if (yearMatch) {
                    details.yearBuilt = parseInt(yearMatch[0], 10);
                    break;
                }
            }
        }
    } catch {
        // Ignore extraction errors - return what we have
    }

    return details;
}

/**
 * Batch check multiple Zillow URLs
 */
export async function batchCheckZillow(
    urls: string[],
    onProgress?: (completed: number, total: number, result: ZillowResult) => void
): Promise<Map<string, ZillowResult>> {
    const results = new Map<string, ZillowResult>();

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];

        // Add delay between requests
        if (i > 0) {
            await randomDelay();
        }

        const result = await checkZillowUrl(url);
        results.set(url, result);

        onProgress?.(i + 1, urls.length, result);
    }

    return results;
}

/**
 * Construct a Zillow search URL from address
 */
export function constructZillowUrl(address: string, city: string, state: string, zip?: string): string {
    // Format address for Zillow URL
    const formattedAddress = address
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');

    const formattedCity = city
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');

    const formattedState = state.toLowerCase();

    // Zillow homedetails URL format
    return `https://www.zillow.com/homedetails/${formattedAddress}-${formattedCity}-${formattedState}${zip ? `-${zip}` : ''}/`;
}
