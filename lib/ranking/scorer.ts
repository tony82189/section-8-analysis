/**
 * Property Ranking Module
 * 
 * Ranks properties based on weighted scoring of multiple investment metrics.
 * Pure functions for deterministic ranking.
 */

import type { Analysis, Property } from '../types';

export interface RankingWeights {
    dscr: number;
    cocReturn: number;
    capRate: number;
    equity20yr: number;
    annualCashflow: number;
}

export interface RankedProperty {
    property: Property;
    analysis: Analysis;
    score: number;
    rank: number;
    breakdown: {
        dscr: { value: number; normalized: number; weighted: number };
        cocReturn: { value: number; normalized: number; weighted: number };
        capRate: { value: number; normalized: number; weighted: number };
        equity20yr: { value: number; normalized: number; weighted: number };
        annualCashflow: { value: number; normalized: number; weighted: number };
    };
}

export interface RankingResult {
    ranked: RankedProperty[];
    topN: RankedProperty[];
    statistics: {
        avgScore: number;
        maxScore: number;
        minScore: number;
        avgDscr: number;
        avgCocReturn: number;
        avgCapRate: number;
    };
}

// Default weights - total should equal 100
const DEFAULT_WEIGHTS: RankingWeights = {
    dscr: 25,           // Higher DSCR = safer, more reliable
    cocReturn: 25,      // Higher CoC = better returns on cash invested
    equity20yr: 20,     // Long-term wealth building
    capRate: 15,        // Fundamental property value
    annualCashflow: 15, // Immediate income
};

// Normalization ranges for each metric
const NORMALIZATION_RANGES = {
    dscr: { min: 0.8, max: 2.5 },
    cocReturn: { min: -5, max: 25 },
    capRate: { min: 4, max: 14 },
    equity20yr: { min: 0, max: 500000 },
    annualCashflow: { min: -2000, max: 15000 },
};

/**
 * Normalize a value to a 0-100 scale
 * Values below min get 0, values above max get 100
 */
function normalizeScore(value: number, min: number, max: number): number {
    if (value <= min) return 0;
    if (value >= max) return 100;
    return ((value - min) / (max - min)) * 100;
}

/**
 * Calculate ranking score for a single property
 */
export function calculateRankScore(
    analysis: Analysis,
    weights: RankingWeights = DEFAULT_WEIGHTS
): { score: number; breakdown: RankedProperty['breakdown'] } {
    const ranges = NORMALIZATION_RANGES;

    // Normalize each metric
    const dscrNorm = normalizeScore(analysis.dscr, ranges.dscr.min, ranges.dscr.max);
    const cocNorm = normalizeScore(analysis.cocReturn, ranges.cocReturn.min, ranges.cocReturn.max);
    const capNorm = normalizeScore(analysis.capRate, ranges.capRate.min, ranges.capRate.max);
    const equityNorm = normalizeScore(analysis.equity20yr, ranges.equity20yr.min, ranges.equity20yr.max);
    const cashflowNorm = normalizeScore(analysis.annualCashflow, ranges.annualCashflow.min, ranges.annualCashflow.max);

    // Calculate weighted scores
    const dscrWeighted = (dscrNorm * weights.dscr) / 100;
    const cocWeighted = (cocNorm * weights.cocReturn) / 100;
    const capWeighted = (capNorm * weights.capRate) / 100;
    const equityWeighted = (equityNorm * weights.equity20yr) / 100;
    const cashflowWeighted = (cashflowNorm * weights.annualCashflow) / 100;

    // Total score (0-100 scale)
    const score = dscrWeighted + cocWeighted + capWeighted + equityWeighted + cashflowWeighted;

    return {
        score: Math.round(score * 100) / 100,
        breakdown: {
            dscr: { value: analysis.dscr, normalized: dscrNorm, weighted: dscrWeighted },
            cocReturn: { value: analysis.cocReturn, normalized: cocNorm, weighted: cocWeighted },
            capRate: { value: analysis.capRate, normalized: capNorm, weighted: capWeighted },
            equity20yr: { value: analysis.equity20yr, normalized: equityNorm, weighted: equityWeighted },
            annualCashflow: { value: analysis.annualCashflow, normalized: cashflowNorm, weighted: cashflowWeighted },
        },
    };
}

/**
 * Rank all properties and return top N
 */
export function rankProperties(
    properties: Property[],
    analyses: Analysis[],
    options: {
        topN?: number;
        weights?: RankingWeights;
        minDscr?: number;
        requirePositiveCashflow?: boolean;
    } = {}
): RankingResult {
    const {
        topN = 10,
        weights = DEFAULT_WEIGHTS,
        minDscr = 0,
        requirePositiveCashflow = false,
    } = options;

    // Create analysis lookup map
    const analysisMap = new Map<string, Analysis>();
    for (const analysis of analyses) {
        analysisMap.set(analysis.propertyId, analysis);
    }

    // Score and filter properties
    const scored: RankedProperty[] = [];

    for (const property of properties) {
        const analysis = analysisMap.get(property.id);
        if (!analysis) continue;

        // Apply filters
        if (minDscr > 0 && analysis.dscr < minDscr) continue;
        if (requirePositiveCashflow && analysis.annualCashflow < 0) continue;

        const { score, breakdown } = calculateRankScore(analysis, weights);

        scored.push({
            property,
            analysis,
            score,
            rank: 0, // Will be set after sorting
            breakdown,
        });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Assign ranks
    scored.forEach((item, index) => {
        item.rank = index + 1;
    });

    // Calculate statistics
    const scores = scored.map(s => s.score);
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const maxScore = scores.length > 0 ? Math.max(...scores) : 0;
    const minScore = scores.length > 0 ? Math.min(...scores) : 0;

    const avgDscr = scored.length > 0
        ? scored.reduce((sum, s) => sum + s.analysis.dscr, 0) / scored.length
        : 0;
    const avgCocReturn = scored.length > 0
        ? scored.reduce((sum, s) => sum + s.analysis.cocReturn, 0) / scored.length
        : 0;
    const avgCapRate = scored.length > 0
        ? scored.reduce((sum, s) => sum + s.analysis.capRate, 0) / scored.length
        : 0;

    return {
        ranked: scored,
        topN: scored.slice(0, topN),
        statistics: {
            avgScore: Math.round(avgScore * 100) / 100,
            maxScore: Math.round(maxScore * 100) / 100,
            minScore: Math.round(minScore * 100) / 100,
            avgDscr: Math.round(avgDscr * 100) / 100,
            avgCocReturn: Math.round(avgCocReturn * 100) / 100,
            avgCapRate: Math.round(avgCapRate * 100) / 100,
        },
    };
}

/**
 * Get default ranking weights
 */
export function getDefaultWeights(): RankingWeights {
    return { ...DEFAULT_WEIGHTS };
}

/**
 * Validate custom weights (must sum to 100)
 */
export function validateWeights(weights: RankingWeights): {
    valid: boolean;
    error?: string;
} {
    const sum = weights.dscr + weights.cocReturn + weights.capRate +
        weights.equity20yr + weights.annualCashflow;

    if (Math.abs(sum - 100) > 0.01) {
        return {
            valid: false,
            error: `Weights must sum to 100 (got ${sum})`,
        };
    }

    for (const [key, value] of Object.entries(weights)) {
        if (value < 0) {
            return {
                valid: false,
                error: `Weight for ${key} cannot be negative`,
            };
        }
    }

    return { valid: true };
}

/**
 * Get ranking grade based on score
 */
export function getGrade(score: number): {
    grade: 'A+' | 'A' | 'B+' | 'B' | 'C+' | 'C' | 'D' | 'F';
    label: string;
    color: string;
} {
    if (score >= 90) return { grade: 'A+', label: 'Excellent', color: '#22c55e' };
    if (score >= 80) return { grade: 'A', label: 'Great', color: '#4ade80' };
    if (score >= 70) return { grade: 'B+', label: 'Good', color: '#84cc16' };
    if (score >= 60) return { grade: 'B', label: 'Above Average', color: '#eab308' };
    if (score >= 50) return { grade: 'C+', label: 'Average', color: '#f97316' };
    if (score >= 40) return { grade: 'C', label: 'Below Average', color: '#ef4444' };
    if (score >= 30) return { grade: 'D', label: 'Poor', color: '#dc2626' };
    return { grade: 'F', label: 'Very Poor', color: '#991b1b' };
}

/**
 * Format score for display
 */
export function formatScore(score: number): string {
    return `${score.toFixed(1)}/100`;
}
