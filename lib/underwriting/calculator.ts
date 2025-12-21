/**
 * BRRRR Underwriting Calculator
 * 
 * Pure functions for calculating DSCR loan underwriting metrics.
 * All functions are deterministic with no side effects - ideal for unit testing.
 */

import type { UnderwritingInput, UnderwritingResult } from '../types';

/**
 * Calculate monthly mortgage payment (Principal + Interest)
 * Uses standard amortization formula: M = P * [r(1+r)^n] / [(1+r)^n - 1]
 * 
 * @param principal - Loan amount
 * @param annualRate - Annual interest rate as decimal (e.g., 0.08 for 8%)
 * @param termYears - Loan term in years
 * @returns Monthly payment amount
 */
export function calculateMonthlyPI(
    principal: number,
    annualRate: number,
    termYears: number
): number {
    if (principal <= 0) return 0;
    if (annualRate <= 0) return principal / (termYears * 12);

    const monthlyRate = annualRate / 12;
    const numPayments = termYears * 12;

    const payment = principal *
        (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) /
        (Math.pow(1 + monthlyRate, numPayments) - 1);

    return roundToCents(payment);
}

/**
 * Calculate remaining loan balance at a given month
 * 
 * @param principal - Original loan amount
 * @param annualRate - Annual interest rate as decimal
 * @param termYears - Loan term in years
 * @param monthsPaid - Number of months paid
 * @returns Remaining balance
 */
export function calculateRemainingBalance(
    principal: number,
    annualRate: number,
    termYears: number,
    monthsPaid: number
): number {
    if (principal <= 0 || monthsPaid <= 0) return principal;

    const monthlyRate = annualRate / 12;
    const numPayments = termYears * 12;

    if (monthsPaid >= numPayments) return 0;

    const balance = principal *
        (Math.pow(1 + monthlyRate, numPayments) - Math.pow(1 + monthlyRate, monthsPaid)) /
        (Math.pow(1 + monthlyRate, numPayments) - 1);

    return Math.max(0, roundToCents(balance));
}

/**
 * Calculate complete BRRRR underwriting analysis
 * 
 * @param input - All input parameters for underwriting
 * @returns Complete underwriting result with all metrics
 */
export function calculateUnderwriting(input: UnderwritingInput): UnderwritingResult {
    const {
        purchasePrice,
        rent,
        downPaymentPercent,
        closingCostPercent,
        interestRate,
        loanTermYears,
        pmFeePercent,
        propertyTaxRate,
        insuranceAnnual,
        vacancyPercent,
        maintenancePercent,
    } = input;

    // Calculate loan structure
    const downPayment = roundToCents(purchasePrice * (downPaymentPercent / 100));
    const closingCosts = roundToCents(purchasePrice * (closingCostPercent / 100));
    const loanAmount = purchasePrice - downPayment;
    const totalInvestment = downPayment + closingCosts;

    // Calculate monthly fixed costs
    const monthlyPI = calculateMonthlyPI(loanAmount, interestRate / 100, loanTermYears);
    const monthlyTaxes = roundToCents((purchasePrice * (propertyTaxRate / 100)) / 12);
    const monthlyInsurance = roundToCents(insuranceAnnual / 12);
    const monthlyPITI = monthlyPI + monthlyTaxes + monthlyInsurance;

    // Calculate monthly variable costs (based on rent)
    const pmFee = roundToCents(rent * (pmFeePercent / 100));
    const vacancy = roundToCents(rent * (vacancyPercent / 100));
    const maintenance = roundToCents(rent * (maintenancePercent / 100));

    // Total monthly expenses
    const totalExpenses = monthlyPITI + pmFee + vacancy + maintenance;

    // Cash flow
    const netCashflow = roundToCents(rent - totalExpenses);
    const annualCashflow = roundToCents(netCashflow * 12);

    // NOI (Net Operating Income) - before debt service
    const operatingExpenses = pmFee + vacancy + maintenance + monthlyTaxes + monthlyInsurance;
    const monthlyNOI = rent - operatingExpenses;
    const annualNOI = roundToCents(monthlyNOI * 12);

    // Key ratios
    const dscr = monthlyPI > 0 ? roundToDecimal(monthlyNOI / monthlyPI, 2) : 0;
    const capRate = purchasePrice > 0 ? roundToDecimal((annualNOI / purchasePrice) * 100, 2) : 0;
    const cocReturn = totalInvestment > 0 ? roundToDecimal((annualCashflow / totalInvestment) * 100, 2) : 0;

    return {
        downPayment,
        closingCosts,
        loanAmount,
        totalInvestment,
        monthlyPI,
        monthlyTaxes,
        monthlyInsurance,
        monthlyPITI,
        pmFee,
        vacancy,
        maintenance,
        totalExpenses,
        netCashflow,
        annualCashflow,
        annualNOI,
        dscr,
        capRate,
        cocReturn,
    };
}

/**
 * Calculate Debt Service Coverage Ratio (DSCR)
 * DSCR = Net Operating Income / Debt Service
 * 
 * Lenders typically require DSCR >= 1.0 (meaning NOI covers debt payments)
 * DSCR < 1.0 means the property doesn't generate enough income to cover debt
 * 
 * @param noi - Annual Net Operating Income
 * @param annualDebtService - Annual debt service (mortgage payments)
 * @returns DSCR ratio
 */
export function calculateDSCR(noi: number, annualDebtService: number): number {
    if (annualDebtService <= 0) return 0;
    return roundToDecimal(noi / annualDebtService, 2);
}

/**
 * Calculate Capitalization Rate (Cap Rate)
 * Cap Rate = NOI / Purchase Price * 100
 * 
 * @param noi - Annual Net Operating Income
 * @param purchasePrice - Purchase price
 * @returns Cap rate as percentage
 */
export function calculateCapRate(noi: number, purchasePrice: number): number {
    if (purchasePrice <= 0) return 0;
    return roundToDecimal((noi / purchasePrice) * 100, 2);
}

/**
 * Calculate Cash-on-Cash Return (CoC)
 * CoC = Annual Cash Flow / Total Cash Invested * 100
 * 
 * @param annualCashflow - Annual net cashflow
 * @param totalInvestment - Total cash invested (down payment + closing costs)
 * @returns CoC return as percentage
 */
export function calculateCoCReturn(annualCashflow: number, totalInvestment: number): number {
    if (totalInvestment <= 0) return 0;
    return roundToDecimal((annualCashflow / totalInvestment) * 100, 2);
}

/**
 * Calculate the maximum purchase price for a target DSCR
 * 
 * @param rent - Monthly rent
 * @param targetDscr - Target DSCR (e.g., 1.25)
 * @param downPaymentPercent - Down payment percentage
 * @param interestRate - Annual interest rate (e.g., 8.0)
 * @param termYears - Loan term in years
 * @param operatingExpensePercent - Operating expenses as % of rent (PM + vacancy + maintenance + tax + insurance)
 * @returns Maximum purchase price to achieve target DSCR
 */
export function calculateMaxPurchasePrice(
    rent: number,
    targetDscr: number,
    downPaymentPercent: number,
    interestRate: number,
    termYears: number,
    operatingExpensePercent: number
): number {
    const monthlyNOI = rent * (1 - operatingExpensePercent / 100);
    const maxMonthlyDebtService = monthlyNOI / targetDscr;

    // Reverse the mortgage formula to find principal
    const monthlyRate = (interestRate / 100) / 12;
    const numPayments = termYears * 12;

    const loanAmount = maxMonthlyDebtService *
        (Math.pow(1 + monthlyRate, numPayments) - 1) /
        (monthlyRate * Math.pow(1 + monthlyRate, numPayments));

    // Purchase price = loan amount / (1 - down payment %)
    const purchasePrice = loanAmount / (1 - downPaymentPercent / 100);

    return roundToCents(purchasePrice);
}

/**
 * Validate underwriting inputs
 */
export function validateUnderwritingInput(input: Partial<UnderwritingInput>): {
    valid: boolean;
    errors: string[];
} {
    const errors: string[] = [];

    if (!input.purchasePrice || input.purchasePrice <= 0) {
        errors.push('Purchase price must be positive');
    }

    if (!input.rent || input.rent <= 0) {
        errors.push('Rent must be positive');
    }

    if (input.downPaymentPercent !== undefined && (input.downPaymentPercent < 0 || input.downPaymentPercent > 100)) {
        errors.push('Down payment must be between 0% and 100%');
    }

    if (input.interestRate !== undefined && (input.interestRate < 0 || input.interestRate > 30)) {
        errors.push('Interest rate must be between 0% and 30%');
    }

    if (input.loanTermYears !== undefined && (input.loanTermYears < 1 || input.loanTermYears > 40)) {
        errors.push('Loan term must be between 1 and 40 years');
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Round a number to cents (2 decimal places)
 */
function roundToCents(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Round a number to specified decimal places
 */
function roundToDecimal(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
}
