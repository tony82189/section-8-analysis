import { v4 as uuidv4 } from 'uuid';
import type { Property, ExtractionResult } from '../types';

/**
 * Section 8 Property Parser
 * 
 * Parses text extracted from Section 8 property listing PDFs (Rhett Wiseman format).
 * Format characteristics:
 * - Zillow URL or address as header
 * - Asking Price, Suggested Offer Price, Estimated Section 8 Rent
 * - Estimated ARV, Rehab Needed
 * - "Needs:" section with repair items
 */

// Regex patterns for the Rhett Wiseman Section 8 email format
const PATTERNS = {
    // Zillow URL pattern
    zillowUrl: /https?:\/\/(?:www\.)?zillow\.com\/homedetails\/[^\s]+/gi,

    // Address patterns (when no Zillow URL)
    streetAddress: /^(\d{1,5}\s+(?:[A-Za-z0-9]+\s+)*(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Ct|Court|Pl(?:ace)?|Way|Cir(?:cle)?|Pkwy|Parkway)\.?(?:\s+[NSEW]\.?)?)/im,

    // Pricing patterns - handles both "$110k" and "$110,000" formats
    askingPrice: /(?:asking(?:\s+price)?)[:\s]*\$?\s*([\d,]+(?:\.\d+)?)\s*k?/i,
    suggestedOffer: /(?:suggested\s+offer(?:\s+price)?)[:\s]*\$?\s*([\d,]+(?:\.\d+)?)\s*k?/i,

    // Rent pattern - handles ranges like "$1,200-$1,300"
    rent: /(?:(?:estimated\s+)?section\s*8\s+rent|rent)[:\s]*\$?\s*([\d,]+)(?:\s*[-–]\s*\$?\s*([\d,]+))?/i,

    // ARV pattern - handles ranges
    arv: /(?:estimated\s+)?ARV[:\s]*\$?\s*([\d,]+)\s*k?(?:\s*[-–]\s*\$?\s*([\d,]+)\s*k?)?/i,

    // Rehab needed
    rehab: /(?:rehab(?:\s+needed)?)[:\s]*(?:~)?\$?\s*([\d,]+(?:\.\d+)?)\s*k?/i,

    // Property details from Zillow URL
    bedsFromUrl: /(\d+)-bd/i,
    bathsFromUrl: /(\d+(?:\.\d)?)-ba/i,

    // Status indicators
    offMarket: /\bOFF\s+MARKET\b/i,
    underContract: /\b(?:UNDER\s+CONTRACT|PENDING|CONTINGENT)\b/i,
    section8Tenant: /\b(?:section\s*8\s+tenant|tenant\s+(?:in\s+place|application\s+accepted))/i,
    occupied: /\b(?:occupied|tenant\s+(?:in\s+place|application))/i,

    // Address extraction from Zillow URL
    addressFromUrl: /homedetails\/([^/]+)-([A-Za-z]+)-([A-Z]{2})-(\d{5})/i,
};

/**
 * Parse price value, handling "k" suffix (e.g., "110k" -> 110000)
 */
function parsePrice(value: string, hasKSuffix: boolean = false): number {
    const cleaned = value.replace(/[$,\s]/g, '');
    let num = parseFloat(cleaned);

    // If the number seems too small (< 1000) and fits the "k" pattern, multiply by 1000
    if (num < 1000 || hasKSuffix) {
        num *= 1000;
    }

    return Math.round(num);
}

/**
 * Extract address components from a Zillow URL
 */
function extractAddressFromZillowUrl(url: string): {
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
} {
    const match = url.match(PATTERNS.addressFromUrl);
    if (!match) {
        return { address: null, city: null, state: null, zip: null };
    }

    // Convert URL slug to address (e.g., "1611-15th-Ave-N" -> "1611 15th Ave N")
    const addressSlug = match[1];
    const address = addressSlug
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');

    const city = match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase();
    const state = match[3].toUpperCase();
    const zip = match[4];

    return { address, city, state, zip };
}

/**
 * Split OCR text into individual property records
 */
function splitIntoPropertyRecords(text: string): string[] {
    const records: string[] = [];

    // Split by Zillow URLs or major address patterns
    // Properties are typically separated by Zillow URLs or clear address headers
    const urlPattern = /(?=https?:\/\/(?:www\.)?zillow\.com\/homedetails\/)/gi;
    const addressPattern = /(?=^\d{1,5}\s+[A-Za-z]+\s+(?:St|Ave|Rd|Blvd|Dr|Ln|Ct|Pl|Way|Cir))/gim;

    // First try splitting by URLs
    let parts = text.split(urlPattern);

    // For parts that don't start with a URL, try to split by address
    const expanded: string[] = [];
    for (const part of parts) {
        if (part.trim().startsWith('http')) {
            expanded.push(part);
        } else if (part.trim().length > 50) {
            // Try to split by address pattern
            const subParts = part.split(addressPattern);
            expanded.push(...subParts.filter(p => p.trim().length > 50));
        }
    }

    // Filter to only include parts that look like property records
    for (const part of expanded) {
        const hasPrice = PATTERNS.askingPrice.test(part);
        const hasRent = PATTERNS.rent.test(part);
        const hasUrl = /zillow\.com/i.test(part);
        const hasAddress = PATTERNS.streetAddress.test(part);

        if ((hasPrice || hasRent) && (hasUrl || hasAddress)) {
            records.push(part.trim());
        }
    }

    return records;
}

/**
 * Parse a single property record from text
 */
function parsePropertyRecord(
    text: string,
    runId: string,
    sourcePage?: number
): Partial<Property> | null {
    const property: Partial<Property> = {
        id: uuidv4(),
        runId,
        status: 'raw',
        needsManualReview: false,
        sourcePage,
        rawText: text.substring(0, 2000), // Limit raw text storage
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    // Extract Zillow URL
    const zillowMatch = text.match(PATTERNS.zillowUrl);
    if (zillowMatch) {
        property.zillowUrl = zillowMatch[0];

        // Extract address from Zillow URL
        const addressInfo = extractAddressFromZillowUrl(zillowMatch[0]);
        property.address = addressInfo.address;
        property.city = addressInfo.city;
        property.state = addressInfo.state;
        property.zip = addressInfo.zip;
    }

    // If no Zillow URL, try to extract street address
    if (!property.address) {
        const addressMatch = text.match(PATTERNS.streetAddress);
        if (addressMatch) {
            property.address = addressMatch[1].trim();
        }
    }

    // Extract asking price
    const askingMatch = text.match(PATTERNS.askingPrice);
    if (askingMatch) {
        const hasK = /k\s*$/i.test(askingMatch[0]);
        property.askingPrice = parsePrice(askingMatch[1], hasK);
    }

    // Extract suggested offer price
    const offerMatch = text.match(PATTERNS.suggestedOffer);
    if (offerMatch) {
        const hasK = /k\s*$/i.test(offerMatch[0]);
        property.suggestedOffer = parsePrice(offerMatch[1], hasK);
    }

    // Extract rent (use higher end of range for analysis)
    const rentMatch = text.match(PATTERNS.rent);
    if (rentMatch) {
        const lowRent = parseInt(rentMatch[1].replace(/,/g, ''), 10);
        const highRent = rentMatch[2] ? parseInt(rentMatch[2].replace(/,/g, ''), 10) : lowRent;
        // Use the higher end of the range for conservative analysis
        property.rent = highRent;
    }

    // Check status indicators
    property.occupied = PATTERNS.occupied.test(text) || PATTERNS.section8Tenant.test(text);
    property.section8Tenant = PATTERNS.section8Tenant.test(text);

    // Check if off market
    if (PATTERNS.offMarket.test(text)) {
        property.zillowStatus = 'off-market';
    } else if (PATTERNS.underContract.test(text)) {
        property.zillowStatus = 'pending';
    }

    // Only return if we have minimum required data
    const hasMinimumData = property.askingPrice || property.rent || property.zillowUrl;
    if (!hasMinimumData) {
        return null;
    }

    // Mark for manual review if missing critical fields
    property.needsManualReview = !property.address || !property.askingPrice || !property.rent;

    return property;
}

/**
 * Parse multiple properties from OCR/extracted text
 */
export function parsePropertiesFromText(
    text: string,
    runId: string,
    options: {
        sourcePage?: number;
    } = {}
): ExtractionResult {
    const { sourcePage } = options;
    const properties: Partial<Property>[] = [];
    const errors: string[] = [];

    try {
        // Split text into individual property records
        const records = splitIntoPropertyRecords(text);

        if (records.length === 0) {
            // Try parsing the entire text as a single record if no splits found
            const singleProperty = parsePropertyRecord(text, runId, sourcePage);
            if (singleProperty) {
                properties.push(singleProperty);
            }
        } else {
            // Parse each record
            for (const record of records) {
                try {
                    const property = parsePropertyRecord(record, runId, sourcePage);
                    if (property) {
                        properties.push(property);
                    }
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to parse record: ${message}`);
                }
            }
        }

        // Calculate confidence based on completeness
        const totalFields = properties.length * 8; // 8 key fields per property
        const filledFields = properties.reduce((count, p) => {
            let filled = 0;
            if (p.address) filled++;
            if (p.city) filled++;
            if (p.state) filled++;
            if (p.zip) filled++;
            if (p.askingPrice) filled++;
            if (p.suggestedOffer) filled++;
            if (p.rent) filled++;
            if (p.zillowUrl) filled++;
            return count + filled;
        }, 0);

        const confidence = totalFields > 0 ? (filledFields / totalFields) * 100 : 0;

        return {
            success: true,
            properties,
            rawText: text,
            confidence: Math.round(confidence),
            method: 'ocr',
            errors,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            success: false,
            properties: [],
            rawText: text,
            confidence: 0,
            method: 'ocr',
            errors: [message],
        };
    }
}

/**
 * Validate a parsed property and identify missing required fields
 */
export function validateProperty(property: Partial<Property>): {
    valid: boolean;
    missingFields: string[];
    warnings: string[];
} {
    const missingFields: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!property.address && !property.zillowUrl) missingFields.push('address or zillowUrl');
    if (!property.askingPrice && property.askingPrice !== 0) missingFields.push('askingPrice');
    if (!property.rent && property.rent !== 0) missingFields.push('rent');

    // Recommended fields
    if (!property.city) warnings.push('city is missing');
    if (!property.state) warnings.push('state is missing');
    if (!property.suggestedOffer) warnings.push('suggestedOffer is missing');

    // Validation rules
    if (property.askingPrice && property.askingPrice < 10000) {
        warnings.push('askingPrice seems too low');
    }
    if (property.rent && property.rent < 100) {
        warnings.push('rent seems too low');
    }
    if (property.rent && property.rent > 5000) {
        warnings.push('rent seems unusually high for Section 8');
    }

    return {
        valid: missingFields.length === 0,
        missingFields,
        warnings,
    };
}

/**
 * Merge partial property data from multiple sources
 */
export function mergePropertyData(
    base: Partial<Property>,
    overlay: Partial<Property>
): Partial<Property> {
    const merged = { ...base };

    // Only copy non-null values from overlay
    for (const [key, value] of Object.entries(overlay)) {
        if (value !== null && value !== undefined && key !== 'id' && key !== 'runId') {
            (merged as Record<string, unknown>)[key] = value;
        }
    }

    merged.updatedAt = new Date().toISOString();

    return merged;
}

/**
 * Clean and normalize extracted text for better parsing
 */
export function normalizeOcrText(text: string): string {
    return text
        // Fix common OCR errors
        .replace(/\|/g, 'I')
        .replace(/l(?=\d)/g, '1') // lowercase L before digit -> 1
        .replace(/O(?=\d)/g, '0') // O before digit -> 0
        // Normalize currency
        .replace(/\$\s+/g, '$')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        // Fix "k" suffix variations
        .replace(/(\d)\s*[kK]\b/g, '$1k')
        .trim();
}
