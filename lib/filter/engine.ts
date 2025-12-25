import type { Property, Settings } from '../types';

export interface FilterResult {
    passed: Property[];
    failed: Property[];
    summary: {
        total: number;
        passed: number;
        failed: number;
        byReason: Record<string, number>;
    };
}

export interface FilterReason {
    field: string;
    reason: string;
    value: unknown;
    threshold: unknown;
}

/**
 * Filter properties based on configurable criteria
 */
export function filterProperties(
    properties: Property[],
    settings: Settings
): FilterResult {
    const passed: Property[] = [];
    const failed: Property[] = [];
    const byReason: Record<string, number> = {};

    for (const property of properties) {
        const reasons = getFilterReasons(property, settings);

        if (reasons.length === 0) {
            // Property passed all filters
            passed.push({
                ...property,
                status: 'filtered',
                updatedAt: new Date().toISOString(),
            });
        } else {
            // Property failed one or more filters
            const reasonStr = reasons.map(r => r.reason).join('; ');
            failed.push({
                ...property,
                status: 'discarded',
                discardReason: reasonStr,
                updatedAt: new Date().toISOString(),
            });

            // Track failure reasons
            for (const reason of reasons) {
                const key = reason.field;
                byReason[key] = (byReason[key] || 0) + 1;
            }
        }
    }

    return {
        passed,
        failed,
        summary: {
            total: properties.length,
            passed: passed.length,
            failed: failed.length,
            byReason,
        },
    };
}

/**
 * Get all filter reasons for a property
 */
export function getFilterReasons(
    property: Property,
    settings: Settings
): FilterReason[] {
    const reasons: FilterReason[] = [];

    // Check minimum rent
    if (property.rent !== null && property.rent < settings.minRent) {
        reasons.push({
            field: 'rent',
            reason: `Rent $${property.rent} below minimum $${settings.minRent}`,
            value: property.rent,
            threshold: settings.minRent,
        });
    }

    // Check minimum bedrooms
    if (property.bedrooms !== null && property.bedrooms < settings.minBedrooms) {
        reasons.push({
            field: 'bedrooms',
            reason: `${property.bedrooms} bedrooms below minimum ${settings.minBedrooms}`,
            value: property.bedrooms,
            threshold: settings.minBedrooms,
        });
    }

    // Check minimum bathrooms
    if (property.bathrooms !== null && property.bathrooms < settings.minBathrooms) {
        reasons.push({
            field: 'bathrooms',
            reason: `${property.bathrooms} bathrooms below minimum ${settings.minBathrooms}`,
            value: property.bathrooms,
            threshold: settings.minBathrooms,
        });
    }

    // Check occupied Section 8 only
    if (settings.occupiedSec8Only) {
        if (!property.occupied || !property.section8Tenant) {
            reasons.push({
                field: 'occupancy',
                reason: 'Not occupied by Section 8 tenant',
                value: { occupied: property.occupied, section8: property.section8Tenant },
                threshold: 'Occupied with Section 8 tenant',
            });
        }
    }

    // Check offer gap threshold
    if (
        property.askingPrice !== null &&
        property.suggestedOffer !== null &&
        settings.offerGapThreshold >= 0
    ) {
        const gap = property.askingPrice - property.suggestedOffer;
        if (gap > settings.offerGapThreshold) {
            reasons.push({
                field: 'offerGap',
                reason: `Offer gap $${gap} exceeds threshold $${settings.offerGapThreshold}`,
                value: gap,
                threshold: settings.offerGapThreshold,
            });
        }
    }

    // Check for missing critical data
    if (property.rent === null) {
        reasons.push({
            field: 'rent',
            reason: 'Rent is missing',
            value: null,
            threshold: 'Required',
        });
    }

    if (property.askingPrice === null) {
        reasons.push({
            field: 'askingPrice',
            reason: 'Asking price is missing',
            value: null,
            threshold: 'Required',
        });
    }

    return reasons;
}

/**
 * Check if a single property passes filters
 */
export function propertyPassesFilter(
    property: Property,
    settings: Settings
): boolean {
    return getFilterReasons(property, settings).length === 0;
}

/**
 * Get default filter settings
 */
export function getDefaultSettings(): Settings {
    return {
        minRent: 1300,
        minBedrooms: 2,
        minBathrooms: 1,
        occupiedSec8Only: false,
        offerGapThreshold: 10000,
        vacancyEnabled: false,
        vacancyPercent: 5,
        maintenanceEnabled: false,
        maintenancePercent: 5,
        downPaymentPercent: 20,
        closingCostPercent: 5,
        dscrRate: 8.0,
        loanTermYears: 30,
        pmFeePercent: 10,
        propertyTaxRate: 1.2,
        insuranceAnnual: 1200,
        rentGrowthPercent: 3,
        appreciationPercent: 3,
        expenseInflationPercent: 3,
        topN: 10,
        sheetsEnabled: false,
        chunkSizePages: 5,
        maxChunkSizeMB: 10,
        enableLLMFallback: false,
        marketStatusEnabled: false,  // Disabled - use manual MCP workflow for checking Zillow
    };
}

/**
 * Merge user settings with defaults
 */
export function mergeSettings(
    userSettings: Partial<Settings>
): Settings {
    return {
        ...getDefaultSettings(),
        ...userSettings,
    };
}

/**
 * Validate settings values
 */
export function validateSettings(settings: Partial<Settings>): {
    valid: boolean;
    errors: string[];
} {
    const errors: string[] = [];

    if (settings.minRent !== undefined && settings.minRent < 0) {
        errors.push('Minimum rent cannot be negative');
    }

    if (settings.minBedrooms !== undefined && settings.minBedrooms < 0) {
        errors.push('Minimum bedrooms cannot be negative');
    }

    if (settings.minBathrooms !== undefined && settings.minBathrooms < 0) {
        errors.push('Minimum bathrooms cannot be negative');
    }

    if (settings.dscrRate !== undefined && (settings.dscrRate < 7 || settings.dscrRate > 8.5)) {
        errors.push('DSCR rate must be between 7% and 8.5%');
    }

    if (settings.downPaymentPercent !== undefined && (settings.downPaymentPercent < 0 || settings.downPaymentPercent > 100)) {
        errors.push('Down payment percent must be between 0% and 100%');
    }

    if (settings.closingCostPercent !== undefined && (settings.closingCostPercent < 0 || settings.closingCostPercent > 100)) {
        errors.push('Closing cost percent must be between 0% and 100%');
    }

    if (settings.pmFeePercent !== undefined && (settings.pmFeePercent < 0 || settings.pmFeePercent > 100)) {
        errors.push('PM fee percent must be between 0% and 100%');
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}
