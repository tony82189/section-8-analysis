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
    // Matches standard addresses like "1234 Main St" or "5678 Oak Ave N"
    streetAddress: /^(\d{1,5}\s+(?:[A-Za-z0-9]+\s+)*(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Ct|Court|Pl(?:ace)?|Way|Cir(?:cle)?|Pkwy|Parkway)\.?(?:\s+[NSEW]\.?)?)/im,

    // Numbered street addresses like "3827 40th" or "4300 6th Ave"
    numberedStreet: /^(\d{1,5}\s+\d+(?:st|nd|rd|th)(?:\s+(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Dr(?:ive)?|Ln|Ct|Pl|Way|Cir))?)/im,

    // Address with property type descriptor like "3827 40th DUPLEX"
    addressWithType: /^(\d{1,5}\s+(?:\d+(?:st|nd|rd|th)|[A-Za-z]+)(?:\s+[A-Za-z]+)?)\s+(DUPLEX|TRIPLEX|FOURPLEX|MULTI)/im,

    // Pricing patterns - handles both "$110k" and "$110,000" formats
    askingPrice: /(?:asking(?:\s+price)?)[:\s]*\$?\s*([\d,]+(?:\.\d+)?)\s*k?/i,
    suggestedOffer: /(?:suggested\s+offer(?:\s+price)?)[:\s]*\$?\s*([\d,]+(?:\.\d+)?)\s*k?/i,

    // Rent pattern - handles ranges like "$1,200-$1,300" and "Current Rent: $1,325"
    rent: /(?:(?:estimated\s+)?section\s*8\s+rent|current\s+rent|rent)[:\s]*\$?\s*([\d,]+)(?:\s*[-–]\s*\$?\s*([\d,]+))?/i,

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

// Patterns that indicate rehab/description text, NOT property listings
const REHAB_INDICATORS = [
    /\bHVAC[s]?\s+installed\b/i,
    /\belectrical\s+rewire[s]?\b/i,
    /\bcode\s+upgrade\b/i,
    /\broof\s+installed\b/i,
    /\brailing[s]?\s+installed\b/i,
    /\brepair[s]?\s+needed\b/i,
    /\brenovation[s]?\b/i,
    /\brehab\s+details\b/i,
    /\bnew\s+(?:roof|windows|siding|flooring)\b/i,
    /\bplumbing\s+(?:updated|replaced)\b/i,
];

/**
 * Check if text appears to be a rehab/renovation description rather than a property listing
 */
function isRehabDescription(text: string): boolean {
    const indicatorCount = REHAB_INDICATORS.filter(pattern => pattern.test(text)).length;
    // If 2+ rehab indicators found, this is likely a rehab description, not a property
    return indicatorCount >= 2;
}

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
export function extractAddressFromZillowUrl(url: string): {
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
 *
 * Detects property boundaries using multiple signals:
 * 1. Zillow URLs (most reliable)
 * 2. Street addresses (e.g., "1234 Main St", "5678 Oak Ave")
 * 3. "OFF MARKET" headers
 * 4. Addresses with descriptors (e.g., "3827 40th DUPLEX")
 */
function splitIntoPropertyRecords(text: string): string[] {
    const records: string[] = [];

    // Normalize line breaks for consistent splitting
    const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Property boundary patterns (ordered by priority)
    // Important: Address patterns should come BEFORE "OFF MARKET" so the address line
    // is included with the property, not the previous one
    const boundaryPatterns = [
        // Zillow URL - most reliable boundary
        /(?=https?:\/\/(?:www\.)?zillow\.com\/homedetails\/)/gi,

        // Address with descriptor on its own line (e.g., "3827 40th DUPLEX", "1234 Main TRIPLEX")
        /(?=\n\d{1,5}\s+(?:\d+(?:st|nd|rd|th)|[A-Za-z]+)(?:\s+[A-Za-z]+)?\s*(?:DUPLEX|TRIPLEX|FOURPLEX|MULTI|UNIT)\s*\n)/gi,

        // Standalone address with numbered street (e.g., "4300 6th Ave", "1782 49th Street")
        /(?=\n\d{1,5}\s+\d+(?:st|nd|rd|th)\s+(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Dr(?:ive)?|Ln|Ct|Pl|Way|Cir)?\s*\n)/gi,

        // Street address at line start (e.g., "1234 Main St", "5678 Oak Ave N")
        /(?=\n\d{1,5}\s+(?:[A-Za-z]+\s+)+(?:St(?:reet)?|Ave(?:nue)?|Rd|Road|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Ct|Court|Pl(?:ace)?|Way|Cir(?:cle)?|Pkwy|Parkway)\.?(?:\s+[NSEW]\.?)?\s*\n)/gi,
    ];

    // Start with the full text
    let parts = [normalizedText];

    // Apply each pattern to split further
    for (const pattern of boundaryPatterns) {
        const newParts: string[] = [];
        for (const part of parts) {
            // Reset regex lastIndex
            pattern.lastIndex = 0;
            const subParts = part.split(pattern);
            newParts.push(...subParts);
        }
        parts = newParts;
    }

    // Filter and validate each part as a potential property record
    for (const part of parts) {
        const trimmed = part.trim();

        // Skip very short parts
        if (trimmed.length < 30) continue;

        // Check for property indicators
        const hasPrice = PATTERNS.askingPrice.test(trimmed) || /asking\s*:?\s*\$?\d/i.test(trimmed);
        const hasRent = PATTERNS.rent.test(trimmed) || /(?:rent|current\s+rent)[:\s]*\$?\d/i.test(trimmed);
        const hasUrl = /zillow\.com/i.test(trimmed);
        const hasAddress = PATTERNS.streetAddress.test(trimmed) || /^\d{1,5}\s+\d+(?:st|nd|rd|th)/i.test(trimmed);
        const hasOffMarket = /^OFF\s+MARKET/i.test(trimmed);

        // Include if it has enough property-like characteristics
        if ((hasPrice || hasRent) && (hasUrl || hasAddress || hasOffMarket)) {
            records.push(trimmed);
        } else if (hasUrl) {
            // Always include if it has a Zillow URL
            records.push(trimmed);
        } else if (hasPrice || hasRent) {
            // Include pricing-only records - they may belong to a URL from the previous page
            // The sliding window in orchestrator will merge them properly
            records.push(trimmed);
        }
    }

    // If no records found, check if the entire text might be one property
    if (records.length === 0) {
        // Skip if this looks like rehab/description text
        if (isRehabDescription(text)) {
            return [];
        }

        const hasPrice = PATTERNS.askingPrice.test(text);
        const hasRent = PATTERNS.rent.test(text);
        if (hasPrice || hasRent) {
            records.push(text.trim());
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

    // If no Zillow URL, try to extract street address using multiple patterns
    if (!property.address) {
        // Try standard street address first (e.g., "1234 Main St")
        let addressMatch = text.match(PATTERNS.streetAddress);
        if (addressMatch) {
            property.address = addressMatch[1].trim();
        }

        // Try address with property type (e.g., "3827 40th DUPLEX")
        if (!property.address) {
            addressMatch = text.match(PATTERNS.addressWithType);
            if (addressMatch) {
                property.address = addressMatch[1].trim();
                // Note: addressMatch[2] contains the property type (DUPLEX, etc.)
            }
        }

        // Try numbered street address (e.g., "4300 6th Ave" or "1782 49th Street")
        if (!property.address) {
            addressMatch = text.match(PATTERNS.numberedStreet);
            if (addressMatch) {
                property.address = addressMatch[1].trim();
            }
        }
    }

    // Extract asking price - try multiple patterns
    let askingMatch = text.match(PATTERNS.askingPrice);
    if (askingMatch) {
        const hasK = /k\s*$/i.test(askingMatch[0]);
        property.askingPrice = parsePrice(askingMatch[1], hasK);
    }

    // Fallback: "Price: $XXk" without "asking" prefix
    if (!property.askingPrice) {
        const priceMatch = text.match(/(?:^|\n)\s*price[:\s]*\$?\s*([\d,]+(?:\.\d+)?)\s*k?/im);
        if (priceMatch) {
            const hasK = /k\s*$/i.test(priceMatch[0]);
            property.askingPrice = parsePrice(priceMatch[1], hasK);
        }
    }

    // Fallback: standalone "$XXk" or "$XX,XXX" near start of text (first 200 chars)
    if (!property.askingPrice) {
        const startText = text.substring(0, 200);
        const standaloneMatch = startText.match(/\$\s*([\d,]+(?:\.\d+)?)\s*k\b/i);
        if (standaloneMatch) {
            property.askingPrice = parsePrice(standaloneMatch[1], true);
        }
    }

    // Extract suggested offer price
    const offerMatch = text.match(PATTERNS.suggestedOffer);
    if (offerMatch) {
        const hasK = /k\s*$/i.test(offerMatch[0]);
        property.suggestedOffer = parsePrice(offerMatch[1], hasK);
    }

    // Extract rent (capture full range)
    const rentMatch = text.match(PATTERNS.rent);
    if (rentMatch) {
        const lowRent = parseInt(rentMatch[1].replace(/,/g, ''), 10);
        const highRent = rentMatch[2] ? parseInt(rentMatch[2].replace(/,/g, ''), 10) : lowRent;
        // Capture both min and max for range display
        property.rentMin = lowRent;
        property.rentMax = highRent;
        // Use the higher end of the range for conservative analysis (backwards compat)
        property.rent = highRent;
    }

    // Extract ARV (capture full range)
    const arvMatch = text.match(PATTERNS.arv);
    if (arvMatch) {
        const hasK1 = /\d\s*k/i.test(arvMatch[0]);
        const lowArv = parsePrice(arvMatch[1], hasK1);
        const highArv = arvMatch[2] ? parsePrice(arvMatch[2], hasK1) : lowArv;
        property.arvMin = lowArv;
        property.arvMax = highArv;
        property.arv = highArv; // backwards compat
    }

    // Extract rehab needed
    const rehabMatch = text.match(PATTERNS.rehab);
    if (rehabMatch) {
        const hasK = /\d\s*k/i.test(rehabMatch[0]);
        property.rehabNeeded = parsePrice(rehabMatch[1], hasK);
    }

    // Check status indicators
    property.occupied = PATTERNS.occupied.test(text) || PATTERNS.section8Tenant.test(text);
    property.section8Tenant = PATTERNS.section8Tenant.test(text);

    // Check if off market deal (special opportunity from PDF)
    if (PATTERNS.offMarket.test(text)) {
        property.zillowStatus = 'off-market';
        property.isOffMarketDeal = true;  // This is a special off-market opportunity from the PDF
    } else if (PATTERNS.underContract.test(text)) {
        property.zillowStatus = 'pending';
    }

    // Only return if we have minimum required data
    // MUST have a valid address OR Zillow URL
    const hasValidAddress = property.address && property.address.length > 5;
    const hasZillowUrl = !!property.zillowUrl;
    const hasPricing = property.askingPrice || property.rent;

    // Only reject rehab text if it has NO valid property identifiers
    // Many property listings include rehab details along with the actual listing
    if (isRehabDescription(text) && !hasZillowUrl && !hasValidAddress && !hasPricing) {
        return null;  // Pure rehab description, no property data
    }

    // Must have (address OR Zillow URL) AND pricing
    if (!hasZillowUrl && !hasValidAddress) {
        return null;  // No valid property identifier
    }

    if (!hasPricing) {
        return null;  // No pricing info
    }

    // Build reviewNotes explaining why flagged for review
    const reviewReasons: string[] = [];
    if (!property.address && !property.zillowUrl) {
        reviewReasons.push('Missing address (no Zillow URL to extract from)');
    }
    if (!property.askingPrice) {
        reviewReasons.push('Missing asking price');
    }
    if (!property.rent) {
        reviewReasons.push('Missing rent estimate');
    }

    property.needsManualReview = reviewReasons.length > 0;
    property.reviewNotes = reviewReasons.length > 0 ? reviewReasons.join('; ') : null;

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
