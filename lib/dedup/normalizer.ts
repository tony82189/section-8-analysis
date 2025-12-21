import type { Property } from '../types';
import {
    findDuplicateByAddress,
    findDuplicateByZillowUrl,
    addToPropertyCache,
} from '../db/sqlite';

export interface DedupResult {
    unique: Property[];
    duplicates: Property[];
    summary: {
        total: number;
        unique: number;
        duplicates: number;
        byMethod: {
            address: number;
            zillowUrl: number;
        };
    };
}

/**
 * Normalize an address for deduplication comparison
 * 
 * Normalizes:
 * - Case
 * - Street suffixes (St -> Street, Ave -> Avenue, etc.)
 * - Unit/Apt formatting
 * - Whitespace
 * - Common abbreviations
 */
export function normalizeAddress(address: string | null): string | null {
    if (!address) return null;

    let normalized = address.toLowerCase().trim();

    // Remove punctuation except hyphens and hashes
    normalized = normalized.replace(/[.,]/g, '');

    // Normalize whitespace
    normalized = normalized.replace(/\s+/g, ' ');

    // Normalize directional prefixes/suffixes
    const directionals: Record<string, string> = {
        'n ': 'north ',
        'n. ': 'north ',
        's ': 'south ',
        's. ': 'south ',
        'e ': 'east ',
        'e. ': 'east ',
        'w ': 'west ',
        'w. ': 'west ',
        ' n$': ' north',
        ' s$': ' south',
        ' e$': ' east',
        ' w$': ' west',
        'ne ': 'northeast ',
        'nw ': 'northwest ',
        'se ': 'southeast ',
        'sw ': 'southwest ',
    };

    for (const [abbr, full] of Object.entries(directionals)) {
        normalized = normalized.replace(new RegExp(abbr, 'gi'), full);
    }

    // Normalize street suffixes
    const suffixes: Record<string, string> = {
        'street': 'st',
        'avenue': 'ave',
        'road': 'rd',
        'drive': 'dr',
        'lane': 'ln',
        'court': 'ct',
        'place': 'pl',
        'boulevard': 'blvd',
        'circle': 'cir',
        'terrace': 'ter',
        'highway': 'hwy',
        'parkway': 'pkwy',
        'expressway': 'expy',
        'way': 'way',
        'trail': 'trl',
        'crossing': 'xing',
    };

    for (const [full, abbr] of Object.entries(suffixes)) {
        // Replace full name with abbreviation at word boundary
        normalized = normalized.replace(new RegExp(`\\b${full}\\b`, 'gi'), abbr);
    }

    // Normalize unit identifiers
    normalized = normalized.replace(/\bapartment\b/gi, 'apt');
    normalized = normalized.replace(/\bunit\b/gi, 'unit');
    normalized = normalized.replace(/\bsuite\b/gi, 'ste');
    normalized = normalized.replace(/\bfloor\b/gi, 'fl');
    normalized = normalized.replace(/\bbuilding\b/gi, 'bldg');

    // Remove 'apt' or 'unit' if followed by hash
    normalized = normalized.replace(/\b(apt|unit)\s*#/gi, '#');

    // Normalize hash prefix
    normalized = normalized.replace(/#\s*/g, '#');

    // Final whitespace cleanup
    normalized = normalized.replace(/\s+/g, ' ').trim();

    return normalized;
}

/**
 * Normalize a Zillow URL for deduplication
 * 
 * Extracts the property ID/path and normalizes trailing slashes, query params, etc.
 */
export function normalizeZillowUrl(url: string | null): string | null {
    if (!url) return null;

    try {
        const parsed = new URL(url);

        // Only process Zillow URLs
        if (!parsed.hostname.includes('zillow.com')) {
            return url.toLowerCase();
        }

        // Extract the path (the homedetails path contains the property ID)
        let path = parsed.pathname.toLowerCase();

        // Remove trailing slash
        path = path.replace(/\/$/, '');

        // Remove common suffixes that don't affect identity
        path = path.replace(/\/(zpid|\d+_zpid)$/i, '');

        // Reconstruct minimal URL
        return `zillow.com${path}`;
    } catch {
        // If URL parsing fails, just normalize case and trim
        return url.toLowerCase().trim();
    }
}

/**
 * Deduplicate properties against existing records
 */
export function deduplicateProperties(
    properties: Property[],
    options: {
        checkDatabase?: boolean;
        addToCache?: boolean;
    } = {}
): DedupResult {
    const { checkDatabase = true, addToCache = true } = options;

    const unique: Property[] = [];
    const duplicates: Property[] = [];
    const seenAddresses = new Set<string>();
    const seenZillowUrls = new Set<string>();

    let addressDupes = 0;
    let zillowDupes = 0;

    for (const property of properties) {
        const normalizedAddress = normalizeAddress(property.address);
        const normalizedZillow = normalizeZillowUrl(property.zillowUrl);

        let isDuplicate = false;
        let dupeReason = '';

        // Check against properties in current batch
        if (normalizedAddress && seenAddresses.has(normalizedAddress)) {
            isDuplicate = true;
            dupeReason = 'Duplicate address in batch';
            addressDupes++;
        } else if (normalizedZillow && seenZillowUrls.has(normalizedZillow)) {
            isDuplicate = true;
            dupeReason = 'Duplicate Zillow URL in batch';
            zillowDupes++;
        }

        // Check against database if enabled
        if (!isDuplicate && checkDatabase) {
            if (normalizedAddress) {
                const existingId = findDuplicateByAddress(normalizedAddress);
                if (existingId) {
                    isDuplicate = true;
                    dupeReason = `Duplicate of existing property ${existingId}`;
                    addressDupes++;
                }
            }

            if (!isDuplicate && normalizedZillow) {
                const existingId = findDuplicateByZillowUrl(normalizedZillow);
                if (existingId) {
                    isDuplicate = true;
                    dupeReason = `Duplicate of existing property ${existingId}`;
                    zillowDupes++;
                }
            }
        }

        if (isDuplicate) {
            duplicates.push({
                ...property,
                status: 'discarded',
                discardReason: dupeReason,
                updatedAt: new Date().toISOString(),
            });
        } else {
            // Mark as unique and track
            unique.push({
                ...property,
                status: 'deduped',
                updatedAt: new Date().toISOString(),
            });

            if (normalizedAddress) seenAddresses.add(normalizedAddress);
            if (normalizedZillow) seenZillowUrls.add(normalizedZillow);

            // Add to database cache
            if (addToCache) {
                addToPropertyCache({
                    id: property.id,
                    addressNormalized: normalizedAddress,
                    zillowUrlNormalized: normalizedZillow,
                    runId: property.runId,
                });
            }
        }
    }

    return {
        unique,
        duplicates,
        summary: {
            total: properties.length,
            unique: unique.length,
            duplicates: duplicates.length,
            byMethod: {
                address: addressDupes,
                zillowUrl: zillowDupes,
            },
        },
    };
}

/**
 * Check if a single property is a duplicate
 */
export function isDuplicate(property: Property): {
    isDuplicate: boolean;
    reason?: string;
    existingId?: string;
} {
    const normalizedAddress = normalizeAddress(property.address);
    const normalizedZillow = normalizeZillowUrl(property.zillowUrl);

    if (normalizedAddress) {
        const existingId = findDuplicateByAddress(normalizedAddress);
        if (existingId && existingId !== property.id) {
            return {
                isDuplicate: true,
                reason: 'Address matches existing property',
                existingId,
            };
        }
    }

    if (normalizedZillow) {
        const existingId = findDuplicateByZillowUrl(normalizedZillow);
        if (existingId && existingId !== property.id) {
            return {
                isDuplicate: true,
                reason: 'Zillow URL matches existing property',
                existingId,
            };
        }
    }

    return { isDuplicate: false };
}
