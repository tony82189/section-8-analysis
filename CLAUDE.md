# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start development server (http://localhost:3000)
npm run build    # Production build
npm run lint     # Run ESLint
```

## Architecture

This is a Next.js 16 (App Router) application for analyzing Section 8 rental property deals from PDF lists. It automates property extraction, filtering, underwriting, and ranking.

### Two-Phase Pipeline

The analysis runs in two phases via `lib/pipeline/orchestrator.ts`:

**Phase 1 - Extraction** (`runPipeline`):
1. Split PDF into single-page chunks
2. Extract text (pdfjs-dist) or OCR (Tesseract.js) or LLM (OpenAI vision)
3. Parse property data using regex patterns
4. Filter by configurable criteria (rent, bedrooms, etc.)
5. Deduplicate by normalized address
6. Pause at `waiting-for-review` status for user review

**Phase 2 - Analysis** (`resumePipeline`):
1. Check Zillow status via Playwright scraper
2. Run underwriting calculations (PITI, cashflow, DSCR, cap rate, CoC)
3. Generate 5/10/20-year forecasts
4. Rank properties by composite score
5. Generate HTML/PDF reports via Playwright

### Key Modules

| Path | Purpose |
|------|---------|
| `lib/pipeline/orchestrator.ts` | Coordinates full analysis flow |
| `lib/pdf/splitter.ts` | Splits PDFs into page chunks |
| `lib/pdf/extractor.ts` | Extracts text from PDFs with pdfjs-dist |
| `lib/ocr/tesseract.ts` | OCR fallback for scanned pages |
| `lib/llm/openai.ts` | Vision-based property extraction |
| `lib/parser/section8.ts` | Regex parsing of property listings |
| `lib/filter/engine.ts` | Configurable property filters |
| `lib/dedup/normalizer.ts` | Address normalization and dedup |
| `lib/zillow/scraper.ts` | Playwright scraper for listing status |
| `lib/underwriting/calculator.ts` | PITI, cashflow, DSCR, cap rate |
| `lib/forecast/projections.ts` | Multi-year equity/cashflow projections |
| `lib/ranking/scorer.ts` | Weighted scoring algorithm |
| `lib/reports/generator.ts` | HTML/PDF report generation |
| `lib/db/sqlite.ts` | SQLite persistence (better-sqlite3) |
| `lib/sheets/client.ts` | Google Sheets export |
| `lib/types/index.ts` | Zod schemas and TypeScript types |

### Data Storage

- **SQLite database**: `data/section8.db` - stores runs, properties, analyses, artifacts, settings
- **Run artifacts**: `data/runs/{runId}/` - original PDF, page chunks, reports
- Properties and analyses stored as JSON blobs in SQLite for flexibility

### API Routes

- `POST /api/upload` - Upload PDF, starts Phase 1
- `GET /api/runs` - List all runs
- `POST /api/runs/[id]/analyze` - Start Phase 2 with settings
- `GET /api/properties` - List properties for a run
- `GET/POST /api/settings` - App settings

### Frontend Pages

- `/` - Dashboard with run list and upload modal
- `/run/[id]` - Run details and progress
- `/run/[id]/review` - Review extracted properties before Phase 2
- `/settings` - Configure underwriting assumptions and filters

## Type System

All core types defined with Zod schemas in `lib/types/index.ts`:
- `Property` - Address, pricing, details, Zillow data, status
- `Analysis` - Underwriting inputs/outputs, forecasts, ranking
- `Run` - Pipeline execution state and progress
- `Settings` - Filter criteria and underwriting assumptions

Import types via: `import type { Property, Analysis, Run, Settings } from '@/lib/types'`

## Path Aliases

Uses `@/*` alias mapped to project root (configured in `tsconfig.json`).
