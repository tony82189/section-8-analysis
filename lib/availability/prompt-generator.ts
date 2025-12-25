import type { Property } from '../types';
import { normalizeAddress } from './response-parser';

/**
 * Generate a Claude prompt for checking property availability on Zillow
 */
export function generateZillowCheckPrompt(properties: Property[]): string {
    const validProperties = properties.filter(p => p.address && p.city && p.state);

    if (validProperties.length === 0) {
        return 'No properties with complete addresses to check.';
    }

    const addresses = validProperties
        .map((p, i) => `${i + 1}. ${p.address}, ${p.city}, ${p.state}${p.zip ? ' ' + p.zip : ''}`)
        .join('\n');

    return `Check the availability status of these ${validProperties.length} properties on Zillow.
For each property, search on Zillow and report the current status.

Properties to check:
${addresses}

Return your results in this EXACT format (one per line):
[ADDRESS] | [STATUS] | [DETAILS]

Where STATUS must be one of: ACTIVE, PENDING, SOLD, OFF-MARKET, NOT-FOUND

Example format:
123 Main St, Memphis, TN 38116 | SOLD | Sold Dec 15, 2024 for $125,000
456 Oak Ave, Memphis, TN 38118 | ACTIVE | Listed at $89,900
789 Pine Rd, Memphis, TN 38120 | PENDING | Under contract
321 Elm St, Memphis, TN 38122 | NOT-FOUND | No Zillow listing found

Begin checking each property now and report the results.`;
}

/**
 * Generate a mapping of property IDs to their index in the prompt
 * Used to match Claude's response back to properties
 */
export function generatePropertyIndexMap(properties: Property[]): Map<number, string> {
    const map = new Map<number, string>();
    const validProperties = properties.filter(p => p.address && p.city && p.state);

    validProperties.forEach((p, i) => {
        map.set(i + 1, p.id);
    });

    return map;
}

/**
 * Get properties that need availability checking
 * (status is deduped and zillowStatus is null or unknown)
 */
export function getPropertiesNeedingCheck(properties: Property[]): Property[] {
    return properties.filter(p =>
        p.status === 'deduped' &&
        (!p.zillowStatus || p.zillowStatus === 'unknown' || p.zillowStatus === 'needs-review')
    );
}

/**
 * Generate a mapping of normalized addresses to property IDs
 * Used to match Claude's response back to properties when line numbers aren't available
 */
export function generateAddressMap(properties: Property[]): Map<string, string> {
    const map = new Map<string, string>();
    const validProperties = properties.filter(p => p.address && p.city && p.state);

    for (const p of validProperties) {
        // Full address with zip
        const fullAddress = `${p.address}, ${p.city}, ${p.state}${p.zip ? ' ' + p.zip : ''}`;
        map.set(normalizeAddress(fullAddress), p.id);

        // Also store without zip for fuzzy matching
        const addressWithoutZip = `${p.address}, ${p.city}, ${p.state}`;
        map.set(normalizeAddress(addressWithoutZip), p.id);

        // Also store just street address + city + state (no commas)
        const simpleAddress = `${p.address} ${p.city} ${p.state}`;
        map.set(normalizeAddress(simpleAddress), p.id);
    }

    return map;
}
