/**
 * Forecast Projections Calculator
 * 
 * Pure functions for calculating 5/10/20 year property investment forecasts.
 * All functions are deterministic with no side effects.
 */

import type { ForecastInput, ForecastResult, ForecastSummary } from '../types';
import { calculateRemainingBalance } from '../underwriting/calculator';

/**
 * Calculate year-by-year forecast for a property investment
 * 
 * @param input - Forecast input parameters
 * @param years - Number of years to project (default: 20)
 * @returns Array of yearly forecast results
 */
export function calculateYearlyForecast(
    input: ForecastInput,
    years: number = 20
): ForecastResult[] {
    const {
        purchasePrice,
        loanAmount,
        annualCashflow,
        appreciationPercent,
        rentGrowthPercent,
        expenseInflationPercent,
        interestRate,
        loanTermYears,
    } = input;

    const results: ForecastResult[] = [];
    let cumulativeCashflow = 0;
    let currentAnnualCashflow = annualCashflow;

    for (let year = 1; year <= years; year++) {
        // Property value with appreciation
        const propertyValue = roundToCents(
            purchasePrice * Math.pow(1 + appreciationPercent / 100, year)
        );

        // Remaining loan balance
        const monthsPaid = year * 12;
        const loanBalance = calculateRemainingBalance(
            loanAmount,
            interestRate / 100,
            loanTermYears,
            monthsPaid
        );

        // Equity = Property Value - Loan Balance
        const equity = roundToCents(propertyValue - loanBalance);

        // Cash flow grows with rent but expenses also inflate
        // Net effect: (rent growth - expense inflation) on the cashflow
        // Simplified: we apply rent growth to cashflow (conservative)
        if (year > 1) {
            // Rent grows, but so do expenses - net effect on cashflow
            // Assuming expenses are ~60% of rent, rent growth has ~40% net impact
            const netGrowthRate = rentGrowthPercent - (expenseInflationPercent * 0.3);
            currentAnnualCashflow = roundToCents(
                currentAnnualCashflow * (1 + netGrowthRate / 100)
            );
        }

        cumulativeCashflow = roundToCents(cumulativeCashflow + currentAnnualCashflow);

        // Total return = Equity + Cumulative Cashflow
        const totalReturn = roundToCents(equity + cumulativeCashflow);

        results.push({
            year,
            propertyValue,
            loanBalance,
            equity,
            annualCashflow: currentAnnualCashflow,
            cumulativeCashflow,
            totalReturn,
        });
    }

    return results;
}

/**
 * Calculate forecast summary with 5/10/20 year snapshots
 * 
 * @param input - Forecast input parameters
 * @returns Summary with key metrics at 5, 10, and 20 years
 */
export function calculateForecastSummary(input: ForecastInput): ForecastSummary {
    const yearByYear = calculateYearlyForecast(input, 20);

    const get = (year: number): ForecastResult | undefined =>
        yearByYear.find(r => r.year === year);

    const year5 = get(5);
    const year10 = get(10);
    const year20 = get(20);

    return {
        equity5yr: year5?.equity ?? 0,
        equity10yr: year10?.equity ?? 0,
        equity20yr: year20?.equity ?? 0,
        cashflow5yr: year5?.cumulativeCashflow ?? 0,
        cashflow10yr: year10?.cumulativeCashflow ?? 0,
        cashflow20yr: year20?.cumulativeCashflow ?? 0,
        totalReturn5yr: year5?.totalReturn ?? 0,
        totalReturn10yr: year10?.totalReturn ?? 0,
        totalReturn20yr: year20?.totalReturn ?? 0,
        yearByYear,
    };
}

/**
 * Calculate when a property becomes cashflow positive (if negative at start)
 * 
 * @param input - Forecast input parameters
 * @returns Year when cashflow turns positive, or null if never
 */
export function calculateBreakevenYear(input: ForecastInput): number | null {
    if (input.annualCashflow >= 0) return 0; // Already positive

    const forecast = calculateYearlyForecast(input, 30);

    for (const result of forecast) {
        if (result.annualCashflow >= 0) {
            return result.year;
        }
    }

    return null; // Never becomes positive in 30 years
}

/**
 * Calculate when total investment is recovered (payback period)
 * 
 * @param input - Forecast input parameters
 * @param totalInvestment - Initial cash invested (down payment + closing costs)
 * @returns Year when cumulative cashflow equals initial investment
 */
export function calculatePaybackPeriod(
    input: ForecastInput,
    totalInvestment: number
): number | null {
    if (input.annualCashflow <= 0) return null; // Never pays back with negative cashflow

    const forecast = calculateYearlyForecast(input, 30);

    for (const result of forecast) {
        if (result.cumulativeCashflow >= totalInvestment) {
            return result.year;
        }
    }

    return null; // Doesn't pay back in 30 years
}

/**
 * Calculate internal rate of return (IRR) for the investment
 * Uses Newton-Raphson method for approximation
 * 
 * @param totalInvestment - Initial cash invested
 * @param annualCashflows - Array of annual cashflows
 * @param exitValue - Final property value (sale price - loan balance)
 * @returns IRR as percentage
 */
export function calculateIRR(
    totalInvestment: number,
    annualCashflows: number[],
    exitValue: number
): number {
    const cashflows = [-totalInvestment, ...annualCashflows];
    cashflows[cashflows.length - 1] += exitValue; // Add exit value to final year

    // Newton-Raphson method
    let rate = 0.1; // Initial guess: 10%
    const maxIterations = 100;
    const tolerance = 0.0001;

    for (let i = 0; i < maxIterations; i++) {
        let npv = 0;
        let derivative = 0;

        for (let t = 0; t < cashflows.length; t++) {
            const discountFactor = Math.pow(1 + rate, t);
            npv += cashflows[t] / discountFactor;
            if (t > 0) {
                derivative -= (t * cashflows[t]) / Math.pow(1 + rate, t + 1);
            }
        }

        if (Math.abs(npv) < tolerance) {
            return roundToDecimal(rate * 100, 2);
        }

        if (Math.abs(derivative) < tolerance) {
            break; // Avoid division by ~zero
        }

        rate = rate - npv / derivative;

        // Bounds check
        if (rate < -0.99) rate = -0.99;
        if (rate > 10) rate = 10;
    }

    return roundToDecimal(rate * 100, 2);
}

/**
 * Calculate equity multiple (total return / initial investment)
 * 
 * @param totalReturn - Total return (equity + cumulative cashflow)
 * @param totalInvestment - Initial cash invested
 * @returns Equity multiple (e.g., 2.5x means 2.5 times initial investment)
 */
export function calculateEquityMultiple(
    totalReturn: number,
    totalInvestment: number
): number {
    if (totalInvestment <= 0) return 0;
    return roundToDecimal(totalReturn / totalInvestment, 2);
}

/**
 * Calculate average annual return
 * 
 * @param totalReturn - Total return
 * @param totalInvestment - Initial investment
 * @param years - Number of years
 * @returns Average annual return as percentage
 */
export function calculateAverageAnnualReturn(
    totalReturn: number,
    totalInvestment: number,
    years: number
): number {
    if (totalInvestment <= 0 || years <= 0) return 0;

    const totalReturnPercent = ((totalReturn - totalInvestment) / totalInvestment) * 100;
    return roundToDecimal(totalReturnPercent / years, 2);
}

/**
 * Compare two investment scenarios
 */
export function compareScenarios(
    scenario1: ForecastInput,
    scenario2: ForecastInput,
    years: number = 20
): {
    scenario1Summary: ForecastSummary;
    scenario2Summary: ForecastSummary;
    winner: 1 | 2 | 'tie';
    difference: number;
} {
    const summary1 = calculateForecastSummary(scenario1);
    const summary2 = calculateForecastSummary(scenario2);

    const return1 = years <= 5 ? summary1.totalReturn5yr :
        years <= 10 ? summary1.totalReturn10yr :
            summary1.totalReturn20yr;

    const return2 = years <= 5 ? summary2.totalReturn5yr :
        years <= 10 ? summary2.totalReturn10yr :
            summary2.totalReturn20yr;

    const difference = Math.abs(return1 - return2);
    const winner = return1 > return2 ? 1 : return1 < return2 ? 2 : 'tie';

    return {
        scenario1Summary: summary1,
        scenario2Summary: summary2,
        winner,
        difference,
    };
}

// ============================================================================
// Utility Functions
// ============================================================================

function roundToCents(value: number): number {
    return Math.round(value * 100) / 100;
}

function roundToDecimal(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
}
