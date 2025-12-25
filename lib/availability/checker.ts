/**
 * Property Availability Checker
 *
 * Checks if properties are available (for sale) or unavailable (sold/pending/off-market).
 * Uses two methods:
 * 1. Direct Zillow URL check (if URL is available)
 * 2. Web search fallback (for properties without Zillow URL)
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { checkZillowUrl, constructZillowUrl } from '../zillow/scraper';
import type { ZillowResult } from '../types';

export type AvailabilityStatus = 'active' | 'pending' | 'sold' | 'off-market' | 'unknown' | 'needs-review';

export interface AvailabilityResult {
    status: AvailabilityStatus;
    source: 'zillow' | 'web-search' | 'none';
    lastChecked: string;
    details?: string;  // e.g., "Sold on 12/8/2024"
    zillowData?: ZillowResult;
}

// Browser instance for web searches (separate from Zillow scraper)
let searchBrowser: Browser | null = null;

const SEARCH_DELAY_MS = 3000;

/**
 * Get or create browser for web searches
 */
async function getSearchBrowser(): Promise<Browser> {
    if (!searchBrowser) {
        searchBrowser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
            ],
        });
    }
    return searchBrowser;
}

/**
 * Close search browser (call on shutdown)
 */
export async function closeSearchBrowser(): Promise<void> {
    if (searchBrowser) {
        await searchBrowser.close();
        searchBrowser = null;
    }
}

// Per-property timeout to prevent any single property from blocking the process
const PROPERTY_CHECK_TIMEOUT_MS = 45000; // 45 seconds max per property

/**
 * Wrap a promise with a timeout
 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
    ]);
}

/**
 * Check property availability via Zillow URL or web search
 */
export async function checkPropertyAvailability(
    zillowUrl: string | null,
    address: string | null,
    city: string | null,
    state: string | null
): Promise<AvailabilityResult> {
    const now = new Date().toISOString();

    // Wrap entire check in a timeout to prevent any single property from blocking
    const timeoutResult: AvailabilityResult = {
        status: 'unknown',
        source: 'none',
        lastChecked: now,
        details: 'Check timed out',
    };

    return withTimeout(
        checkPropertyAvailabilityInternal(zillowUrl, address, city, state, now),
        PROPERTY_CHECK_TIMEOUT_MS,
        timeoutResult
    );
}

/**
 * Internal availability check (wrapped by timeout)
 */
async function checkPropertyAvailabilityInternal(
    zillowUrl: string | null,
    address: string | null,
    city: string | null,
    state: string | null,
    now: string
): Promise<AvailabilityResult> {
    // Method 1: Use Zillow URL if available
    if (zillowUrl) {
        try {
            console.log(`[Availability] Checking Zillow URL: ${zillowUrl}`);
            const zillowData = await checkZillowUrl(zillowUrl);

            // If we got a definitive status, return it
            if (zillowData.status !== 'needs-review' && zillowData.status !== 'unknown') {
                return {
                    status: zillowData.status,
                    source: 'zillow',
                    lastChecked: now,
                    zillowData,
                };
            }
            // Otherwise fall through to web search for better results
            console.log(`[Availability] Zillow returned ${zillowData.status}, trying web search...`);
        } catch (err) {
            console.error(`[Availability] Zillow check failed:`, err);
            // Fall through to web search
        }
    }

    // Method 2: Try to construct Zillow URL from address
    if (address && city && state && !zillowUrl) {
        try {
            const constructedUrl = constructZillowUrl(address, city, state);
            console.log(`[Availability] Trying constructed Zillow URL: ${constructedUrl}`);
            const zillowData = await checkZillowUrl(constructedUrl);

            // If we get a valid response (not 404), use it
            if (zillowData.status !== 'needs-review') {
                return {
                    status: zillowData.status,
                    source: 'zillow',
                    lastChecked: now,
                    zillowData,
                };
            }
        } catch (err) {
            console.error(`[Availability] Constructed URL check failed:`, err);
            // Fall through to web search
        }
    }

    // Method 3: Web search for property status using address
    if (address && city && state) {
        try {
            console.log(`[Availability] Searching web for: ${address}, ${city}, ${state}`);
            const searchResult = await searchPropertyStatus(address, city, state);
            return {
                status: searchResult.status,
                source: 'web-search',
                lastChecked: now,
                details: searchResult.details,
            };
        } catch (err) {
            console.error(`[Availability] Web search failed:`, err);
        }
    }

    // No way to check
    console.log(`[Availability] Unable to check availability - insufficient data`);
    return {
        status: 'unknown',
        source: 'none',
        lastChecked: now,
    };
}

/**
 * Close browser and clean up resources
 * Call this when shutting down to prevent memory leaks
 */
export async function cleanupAvailabilityChecker(): Promise<void> {
    await closeSearchBrowser();
}

/**
 * Search web for property status using address
 * Uses lightweight fetch requests first, falls back to browser if needed
 */
async function searchPropertyStatus(
    address: string,
    city: string,
    state: string
): Promise<{ status: AvailabilityStatus; details?: string }> {
    const query = `${address} ${city} ${state} zillow`;

    // Method 1: Try DuckDuckGo instant answers API (lightweight, no browser needed)
    try {
        console.log(`[Availability] Trying DuckDuckGo API for: ${query}`);
        const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
        const response = await fetch(ddgUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            },
            signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
            const data = await response.json();
            const abstractText = (data.Abstract || '') + ' ' + (data.AbstractText || '');
            if (abstractText.length > 50) {
                console.log(`[Availability] DuckDuckGo API returned ${abstractText.length} chars`);
                const result = parseStatusFromContent(abstractText.toLowerCase());
                if (result.status !== 'unknown') {
                    console.log(`[Availability] DuckDuckGo API found status: ${result.status}`);
                    return result;
                }
            }
        }
    } catch (err) {
        console.log(`[Availability] DuckDuckGo API failed:`, err instanceof Error ? err.message : err);
    }

    // Method 2: Try browser-based search with multiple engines
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
        const browser = await getSearchBrowser();
        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
        });
        page = await context.newPage();

        const searchQuery = `${address} ${city} ${state} property sold`;

        // Try multiple search engines
        const searchEngines = [
            {
                name: 'Bing',
                url: `https://www.bing.com/search?q=${encodeURIComponent(searchQuery)}`,
            },
            {
                name: 'DuckDuckGo',
                url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`,
            },
        ];

        for (const engine of searchEngines) {
            console.log(`[Availability] Trying ${engine.name} search: ${searchQuery}`);

            try {
                await page.goto(engine.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000,
                });

                // Wait briefly for content
                await page.waitForTimeout(1500);

                // Get visible text content
                let visibleText = '';
                try {
                    visibleText = await page.evaluate(() => document.body.innerText || '');
                } catch {
                    visibleText = await page.content();
                }

                const contentLower = visibleText.toLowerCase();
                console.log(`[Availability] ${engine.name} result length: ${visibleText.length} chars`);

                // Check for explicit blocking indicators
                const isBlocked = contentLower.includes('captcha') ||
                    contentLower.includes('unusual traffic') ||
                    contentLower.includes('verify you are human') ||
                    contentLower.includes('access denied') ||
                    contentLower.includes('robot') ||
                    contentLower.includes('are you a robot');

                if (isBlocked) {
                    console.log(`[Availability] ${engine.name} appears blocked, trying next...`);
                    continue;
                }

                // If we got very little content, try next engine
                if (visibleText.length < 300) {
                    console.log(`[Availability] ${engine.name} insufficient results, trying next...`);
                    continue;
                }

                // Parse the results
                const result = parseStatusFromContent(contentLower);
                if (result.status !== 'unknown') {
                    console.log(`[Availability] ${engine.name} found status: ${result.status}`);
                    return result;
                }
            } catch (err) {
                console.log(`[Availability] ${engine.name} failed:`, err instanceof Error ? err.message : err);
                continue;
            }
        }

        // All search engines failed or returned unknown
        return { status: 'unknown' };

    } finally {
        if (page) await page.close().catch(() => { });
        if (context) await context.close().catch(() => { });
    }
}

/**
 * Parse property status from search results content
 */
function parseStatusFromContent(content: string): { status: AvailabilityStatus; details?: string } {
    // Check for sold indicators with date extraction
    const soldPatterns = [
        /sold\s+(?:on\s+)?(\w+\s+\d{1,2},?\s+\d{4})/i,
        /sold\s+(?:on\s+)?(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
        /sold\s+-\s+(\w+\s+\d{4})/i,
    ];

    for (const pattern of soldPatterns) {
        const match = content.match(pattern);
        if (match) {
            return {
                status: 'sold',
                details: `Sold on ${match[1]}`,
            };
        }
    }

    // Check for general sold status
    if (
        content.includes('sold') &&
        (content.includes('zillow') || content.includes('realtor') || content.includes('redfin'))
    ) {
        // Look for specific sold phrases
        if (
            content.includes('was sold') ||
            content.includes('sold for') ||
            content.includes('sold price') ||
            content.includes('recently sold')
        ) {
            return { status: 'sold', details: 'Recently sold' };
        }
    }

    // Check for pending/under contract
    if (
        content.includes('pending') ||
        content.includes('under contract') ||
        content.includes('contingent') ||
        content.includes('sale pending')
    ) {
        return { status: 'pending', details: 'Under contract' };
    }

    // Check for active/for sale status
    if (
        content.includes('for sale') ||
        content.includes('active listing') ||
        content.includes('list price') ||
        content.includes('asking price') ||
        content.includes('listed for')
    ) {
        return { status: 'active' };
    }

    // Check for off-market
    if (
        content.includes('off market') ||
        content.includes('off-market') ||
        content.includes('not currently listed') ||
        content.includes('no longer listed')
    ) {
        return { status: 'off-market', details: 'Not currently listed' };
    }

    // Unable to determine
    return { status: 'unknown' };
}

/**
 * Batch check availability for multiple properties
 */
export async function batchCheckAvailability(
    properties: Array<{
        id: string;
        zillowUrl: string | null;
        address: string | null;
        city: string | null;
        state: string | null;
    }>,
    onProgress?: (completed: number, total: number, result: AvailabilityResult & { id: string }) => void
): Promise<Map<string, AvailabilityResult>> {
    const results = new Map<string, AvailabilityResult>();

    for (let i = 0; i < properties.length; i++) {
        const property = properties[i];

        // Add delay between requests
        if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, SEARCH_DELAY_MS));
        }

        const result = await checkPropertyAvailability(
            property.zillowUrl,
            property.address,
            property.city,
            property.state
        );

        results.set(property.id, result);

        onProgress?.(i + 1, properties.length, { ...result, id: property.id });
    }

    return results;
}
