import type { Property } from '../types';

export interface ValidationResult {
    valid: boolean;
    issues: string[];
    shouldFlag: boolean;
}

/**
 * Validate extracted property data using sanity checks.
 * Catches impossible/suspicious values that indicate hallucination.
 */
export function validatePropertyData(property: Partial<Property>): ValidationResult {
    const issues: string[] = [];

    // Price range check for Birmingham Section 8 market
    if (property.askingPrice) {
        if (property.askingPrice < 20000) {
            issues.push('Price unusually low (<$20k)');
        }
        if (property.askingPrice > 250000) {
            issues.push('Price unusually high (>$250k)');
        }
    }

    // Rent/Price yield check (8-18% typical for Section 8)
    if (property.askingPrice && property.rent) {
        const annualYield = (property.rent * 12) / property.askingPrice;
        if (annualYield < 0.06) {
            issues.push(`Yield too low: ${(annualYield * 100).toFixed(1)}% - check if price is wrong`);
        }
        if (annualYield > 0.25) {
            issues.push(`Yield too high: ${(annualYield * 100).toFixed(1)}% - check if rent/price are wrong`);
        }
    }

    // Investment vs ARV check
    if (property.askingPrice && property.rehabNeeded !== undefined && property.rehabNeeded !== null && property.arv) {
        const totalCost = property.askingPrice + property.rehabNeeded;
        if (totalCost > property.arv * 1.1) {
            issues.push('Total investment exceeds ARV by >10%');
        }
    }

    // Address consistency with Zillow URL
    if (property.address && property.zillowUrl) {
        const urlMatch = property.zillowUrl.match(/homedetails\/(\d+)-([^/]+)-/);
        if (urlMatch) {
            const urlStreetNum = urlMatch[1];
            if (!property.address.startsWith(urlStreetNum)) {
                issues.push('Address street number doesn\'t match Zillow URL');
            }
        }
    }

    // Rent range sanity check
    if (property.rentMin && property.rentMax) {
        if (property.rentMin > property.rentMax) {
            issues.push('Rent min > rent max - values may be swapped');
        }
        if (property.rentMax > 5000) {
            issues.push('Rent unusually high (>$5,000)');
        }
    }

    // ARV range sanity check
    if (property.arvMin && property.arvMax) {
        if (property.arvMin > property.arvMax) {
            issues.push('ARV min > ARV max - values may be swapped');
        }
    }

    // Rehab sanity check
    if (property.rehabNeeded !== undefined && property.rehabNeeded !== null) {
        if (property.rehabNeeded < 0) {
            issues.push('Rehab cannot be negative');
        }
        if (property.rehabNeeded > 100000) {
            issues.push('Rehab unusually high (>$100k)');
        }
    }

    return {
        valid: issues.length === 0,
        issues,
        shouldFlag: issues.length > 0
    };
}

/**
 * Batch validate multiple properties
 */
export function validateProperties(properties: Partial<Property>[]): {
    validCount: number;
    flaggedCount: number;
    results: Map<string, ValidationResult>;
} {
    const results = new Map<string, ValidationResult>();
    let validCount = 0;
    let flaggedCount = 0;

    for (const property of properties) {
        const result = validatePropertyData(property);
        if (property.id) {
            results.set(property.id, result);
        }
        if (result.valid) {
            validCount++;
        } else {
            flaggedCount++;
        }
    }

    return { validCount, flaggedCount, results };
}
