import { z } from 'zod';

// ============================================================================
// Property Schema
// ============================================================================

export const PropertySchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),

  // Address fields
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().max(2).nullable(),
  zip: z.string().nullable(),

  // Pricing
  askingPrice: z.number().positive().nullable(),
  suggestedOffer: z.number().positive().nullable(),

  // Property details
  rent: z.number().positive().nullable(),
  rentMin: z.number().positive().nullable().optional(),
  rentMax: z.number().positive().nullable().optional(),
  bedrooms: z.number().int().min(0).nullable(),
  bathrooms: z.number().min(0).nullable(),
  sqft: z.number().positive().nullable(),
  yearBuilt: z.number().int().min(1800).max(2030).nullable(),
  arv: z.number().positive().nullable(),
  arvMin: z.number().positive().nullable().optional(),
  arvMax: z.number().positive().nullable().optional(),
  rehabNeeded: z.number().min(0).nullable(),

  // Occupancy
  occupied: z.boolean().nullable(),
  section8Tenant: z.boolean().nullable(),

  // Zillow data
  zillowUrl: z.string().url().nullable(),
  zillowStatus: z.enum(['active', 'pending', 'sold', 'off-market', 'unknown', 'needs-review']).nullable(),
  zillowZestimate: z.number().positive().nullable(),
  zillowLastChecked: z.string().datetime().nullable(),

  // Availability tracking
  isOffMarketDeal: z.boolean().default(false),  // True if PDF says "OFF MARKET" (special deal)
  availabilitySource: z.enum(['zillow', 'web-search', 'manual', 'claude-import', 'none']).nullable(),  // How availability was checked
  availabilityDetails: z.string().nullable(),  // e.g., "Sold on 12/8/2024"

  // Processing status
  status: z.enum(['raw', 'filtered', 'deduped', 'reviewed', 'analyzed', 'discarded']),
  discardReason: z.string().nullable(),
  needsManualReview: z.boolean().default(false),
  reviewNotes: z.string().nullable(),

  // Metadata
  sourceChunk: z.string().nullable(),
  sourcePage: z.number().int().nullable(),
  rawText: z.string().nullable(),

  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Property = z.infer<typeof PropertySchema>;

// ============================================================================
// Analysis Schema
// ============================================================================

export const AnalysisSchema = z.object({
  id: z.string().uuid(),
  propertyId: z.string().uuid(),
  runId: z.string().uuid(),

  // Input values used
  purchasePrice: z.number(),
  downPaymentPercent: z.number(),
  closingCostPercent: z.number(),
  interestRate: z.number(),
  loanTermYears: z.number(),
  pmFeePercent: z.number(),
  vacancyPercent: z.number(),
  maintenancePercent: z.number(),
  propertyTaxRate: z.number(),
  insuranceAnnual: z.number(),

  // Calculated loan values
  downPayment: z.number(),
  closingCosts: z.number(),
  loanAmount: z.number(),
  totalInvestment: z.number(),

  // Monthly breakdown
  monthlyPI: z.number(),
  monthlyTaxes: z.number(),
  monthlyInsurance: z.number(),
  monthlyPITI: z.number(),
  monthlyRent: z.number(),
  pmFee: z.number(),
  vacancy: z.number(),
  maintenance: z.number(),
  totalExpenses: z.number(),
  netCashflow: z.number(),

  // Annual metrics
  annualCashflow: z.number(),
  annualNOI: z.number(),

  // Key ratios
  dscr: z.number(),
  capRate: z.number(),
  cocReturn: z.number(),

  // Forecasts
  equity5yr: z.number(),
  equity10yr: z.number(),
  equity20yr: z.number(),
  cashflow5yr: z.number(),
  cashflow10yr: z.number(),
  cashflow20yr: z.number(),
  totalReturn5yr: z.number(),
  totalReturn10yr: z.number(),
  totalReturn20yr: z.number(),

  // Ranking
  rankScore: z.number(),
  rank: z.number().nullable(),

  createdAt: z.string().datetime(),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

// ============================================================================
// Run Schema
// ============================================================================

export const RunStatusSchema = z.enum([
  'pending',
  'splitting',
  'extracting',
  'parsing',
  'filtering',
  'deduping',
  'checking-availability',
  'checking-zillow',
  'underwriting',
  'forecasting',
  'ranking',
  'generating-reports',
  'waiting-for-review',
  'completed',
  'failed',
  'cancelled'
]);

export const RunSchema = z.object({
  id: z.string().uuid(),
  fileHash: z.string(),
  fileName: z.string(),
  filePath: z.string().nullable(),
  fileSize: z.number(),

  status: RunStatusSchema,
  dryRun: z.boolean().default(false),

  // Progress tracking
  currentStep: z.string().nullable(),
  progress: z.number().min(0).max(100).default(0),

  // Counts
  totalPages: z.number().nullable(),
  chunksCreated: z.number().nullable(),
  propertiesExtracted: z.number().nullable(),
  propertiesFiltered: z.number().nullable(),
  propertiesDeduped: z.number().nullable(),
  propertiesUnavailable: z.number().nullable(),  // Count of sold/pending/off-market
  propertiesAnalyzed: z.number().nullable(),
  topNCount: z.number().nullable(),

  // Error tracking
  error: z.string().nullable(),

  // Timestamps
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export type Run = z.infer<typeof RunSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;

// ============================================================================
// Settings Schema
// ============================================================================

export const SettingsSchema = z.object({
  // Filter criteria
  minRent: z.number().default(1300),
  minBedrooms: z.number().int().default(2),
  minBathrooms: z.number().default(1),
  occupiedSec8Only: z.boolean().default(false),
  offerGapThreshold: z.number().default(10000),

  // Expense toggles
  vacancyEnabled: z.boolean().default(false),
  vacancyPercent: z.number().default(5),
  maintenanceEnabled: z.boolean().default(false),
  maintenancePercent: z.number().default(5),

  // Underwriting assumptions
  downPaymentPercent: z.number().default(20),
  closingCostPercent: z.number().default(5),
  dscrRate: z.number().min(7).max(8.5).default(8.0),
  loanTermYears: z.number().default(30),
  pmFeePercent: z.number().default(10),
  propertyTaxRate: z.number().default(1.2),
  insuranceAnnual: z.number().default(1200),

  // Forecast assumptions
  rentGrowthPercent: z.number().default(3),
  appreciationPercent: z.number().default(3),
  expenseInflationPercent: z.number().default(3),

  // Ranking
  topN: z.number().int().default(10),

  // Google Sheets
  spreadsheetId: z.string().optional(),
  sheetsEnabled: z.boolean().default(false),

  // Processing
  chunkSizePages: z.number().int().default(5),
  maxChunkSizeMB: z.number().default(10),
  enableLLMFallback: z.boolean().default(false),
  llmProvider: z.enum(['openai', 'anthropic', 'google']).optional(),
  llmApiKey: z.string().optional(),

  // Market status checking - disabled by default (use manual MCP workflow)
  marketStatusEnabled: z.boolean().default(false),
});

export type Settings = z.infer<typeof SettingsSchema>;

// ============================================================================
// Job Schema
// ============================================================================

export const JobTypeSchema = z.enum([
  'split-pdf',
  'extract-text',
  'ocr-page',
  'parse-properties',
  'filter-properties',
  'dedup-properties',
  'check-zillow',
  'run-underwriting',
  'run-forecast',
  'rank-properties',
  'generate-report',
]);

export const JobStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const JobSchema = z.object({
  id: z.string().uuid(),
  type: JobTypeSchema,
  status: JobStatusSchema,
  priority: z.number().default(0),
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  attempts: z.number().default(0),
  maxAttempts: z.number().default(3),
  runAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export type Job = z.infer<typeof JobSchema>;
export type JobType = z.infer<typeof JobTypeSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;

// ============================================================================
// Artifact Schema
// ============================================================================

export const ArtifactTypeSchema = z.enum([
  'uploaded-pdf',
  'chunk-pdf',
  'chunk-image',
  'extracted-text',
  'ocr-result',
  'raw-properties',
  'filtered-properties',
  'analysis-results',
  'report-html',
  'report-pdf',
]);

export const ArtifactSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  type: ArtifactTypeSchema,
  path: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ============================================================================
// Extraction Types
// ============================================================================

export interface ExtractionResult {
  success: boolean;
  properties: Partial<Property>[];
  rawText: string;
  confidence: number;
  method: 'text' | 'ocr' | 'llm';
  errors: string[];
}

export interface ChunkInfo {
  id: string;
  runId: string;
  pageStart: number;
  pageEnd: number;
  path: string;
  size: number;
  hasText: boolean;
}

// ============================================================================
// Zillow Types
// ============================================================================

export interface ZillowResult {
  url: string;
  status: 'active' | 'pending' | 'sold' | 'off-market' | 'unknown' | 'needs-review';
  zestimate: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  yearBuilt: number | null;
  lastUpdated: string;
  error?: string;
}

// ============================================================================
// Underwriting Types
// ============================================================================

export interface UnderwritingInput {
  purchasePrice: number;
  rent: number;
  downPaymentPercent: number;
  closingCostPercent: number;
  interestRate: number;
  loanTermYears: number;
  pmFeePercent: number;
  propertyTaxRate: number;
  insuranceAnnual: number;
  vacancyPercent: number;
  maintenancePercent: number;
}

export interface UnderwritingResult {
  downPayment: number;
  closingCosts: number;
  loanAmount: number;
  totalInvestment: number;
  monthlyPI: number;
  monthlyTaxes: number;
  monthlyInsurance: number;
  monthlyPITI: number;
  pmFee: number;
  vacancy: number;
  maintenance: number;
  totalExpenses: number;
  netCashflow: number;
  annualCashflow: number;
  annualNOI: number;
  dscr: number;
  capRate: number;
  cocReturn: number;
}

// ============================================================================
// Forecast Types
// ============================================================================

export interface ForecastInput {
  purchasePrice: number;
  loanAmount: number;
  annualCashflow: number;
  appreciationPercent: number;
  rentGrowthPercent: number;
  expenseInflationPercent: number;
  interestRate: number;
  loanTermYears: number;
}

export interface ForecastResult {
  year: number;
  propertyValue: number;
  loanBalance: number;
  equity: number;
  annualCashflow: number;
  cumulativeCashflow: number;
  totalReturn: number;
}

export interface ForecastSummary {
  equity5yr: number;
  equity10yr: number;
  equity20yr: number;
  cashflow5yr: number;
  cashflow10yr: number;
  cashflow20yr: number;
  totalReturn5yr: number;
  totalReturn10yr: number;
  totalReturn20yr: number;
  yearByYear: ForecastResult[];
}
