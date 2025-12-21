/**
 * Report Generator
 * 
 * Generates HTML and PDF reports for top N properties.
 * Uses Playwright for HTML to PDF conversion.
 */

import { chromium, Browser } from 'playwright';
import * as fs from 'fs/promises';
import path from 'path';
import type { Property, Analysis } from '../types';
import { RankedProperty } from '../ranking/scorer';

let browser: Browser | null = null;

/**
 * Get or create browser for PDF generation
 */
async function getBrowser(): Promise<Browser> {
    if (!browser) {
        browser = await chromium.launch({ headless: true });
    }
    return browser;
}

/**
 * Close browser (call on shutdown)
 */
export async function closeBrowser(): Promise<void> {
    if (browser) {
        await browser.close();
        browser = null;
    }
}

/**
 * Format currency
 */
function formatCurrency(value: number | null | undefined): string {
    if (value === null || value === undefined) return 'N/A';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    }).format(value);
}

/**
 * Format percentage
 */
function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined) return 'N/A';
    return `${value.toFixed(2)}%`;
}

/**
 * Get color class based on value (for DSCR, CoC, etc.)
 */
function getValueClass(value: number, thresholds: { good: number; warning: number }): string {
    if (value >= thresholds.good) return 'good';
    if (value >= thresholds.warning) return 'warning';
    return 'poor';
}

/**
 * Generate HTML report for a single property
 */
function generatePropertyCard(ranked: RankedProperty, index: number): string {
    const { property, analysis, score } = ranked;

    const dscrClass = getValueClass(analysis.dscr, { good: 1.25, warning: 1.0 });
    const cocClass = getValueClass(analysis.cocReturn, { good: 10, warning: 5 });
    const cashflowClass = analysis.netCashflow >= 200 ? 'good' : analysis.netCashflow >= 0 ? 'warning' : 'poor';

    return `
    <div class="property-card">
      <div class="property-header">
        <div class="rank">#${index + 1}</div>
        <div class="score">Score: ${score.toFixed(1)}/100</div>
      </div>
      
      <h3 class="property-address">
        ${property.address || 'Address Unknown'}
        ${property.city ? `, ${property.city}` : ''}
        ${property.state ? `, ${property.state}` : ''}
        ${property.zip || ''}
      </h3>
      
      ${property.zillowUrl ? `<a href="${property.zillowUrl}" class="zillow-link" target="_blank">View on Zillow →</a>` : ''}
      
      <div class="metrics-grid">
        <div class="metric">
          <span class="metric-label">Asking Price</span>
          <span class="metric-value">${formatCurrency(property.askingPrice)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Monthly Rent</span>
          <span class="metric-value">${formatCurrency(property.rent)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Down Payment</span>
          <span class="metric-value">${formatCurrency(analysis.downPayment)}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Total Investment</span>
          <span class="metric-value">${formatCurrency(analysis.totalInvestment)}</span>
        </div>
      </div>
      
      <div class="key-metrics">
        <div class="key-metric ${dscrClass}">
          <span class="key-metric-value">${analysis.dscr.toFixed(2)}</span>
          <span class="key-metric-label">DSCR</span>
        </div>
        <div class="key-metric ${cocClass}">
          <span class="key-metric-value">${formatPercent(analysis.cocReturn)}</span>
          <span class="key-metric-label">CoC Return</span>
        </div>
        <div class="key-metric ${cashflowClass}">
          <span class="key-metric-value">${formatCurrency(analysis.netCashflow)}</span>
          <span class="key-metric-label">Monthly Cashflow</span>
        </div>
        <div class="key-metric">
          <span class="key-metric-value">${formatPercent(analysis.capRate)}</span>
          <span class="key-metric-label">Cap Rate</span>
        </div>
      </div>
      
      <div class="forecast-section">
        <h4>Forecast Projections</h4>
        <table class="forecast-table">
          <thead>
            <tr>
              <th></th>
              <th>5 Years</th>
              <th>10 Years</th>
              <th>20 Years</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Equity</td>
              <td>${formatCurrency(analysis.equity5yr)}</td>
              <td>${formatCurrency(analysis.equity10yr)}</td>
              <td>${formatCurrency(analysis.equity20yr)}</td>
            </tr>
            <tr>
              <td>Cumulative Cashflow</td>
              <td>${formatCurrency(analysis.cashflow5yr)}</td>
              <td>${formatCurrency(analysis.cashflow10yr)}</td>
              <td>${formatCurrency(analysis.cashflow20yr)}</td>
            </tr>
            <tr>
              <td>Total Return</td>
              <td>${formatCurrency(analysis.totalReturn5yr)}</td>
              <td>${formatCurrency(analysis.totalReturn10yr)}</td>
              <td>${formatCurrency(analysis.totalReturn20yr)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      
      <div class="monthly-breakdown">
        <h4>Monthly Breakdown</h4>
        <div class="breakdown-grid">
          <div class="breakdown-item">
            <span>P&I</span>
            <span>${formatCurrency(analysis.monthlyPI)}</span>
          </div>
          <div class="breakdown-item">
            <span>Taxes</span>
            <span>${formatCurrency(analysis.monthlyTaxes)}</span>
          </div>
          <div class="breakdown-item">
            <span>Insurance</span>
            <span>${formatCurrency(analysis.monthlyInsurance)}</span>
          </div>
          <div class="breakdown-item">
            <span>PM Fee</span>
            <span>${formatCurrency(analysis.pmFee)}</span>
          </div>
          <div class="breakdown-item total">
            <span>Total Expenses</span>
            <span>${formatCurrency(analysis.totalExpenses)}</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Generate full HTML report
 */
export function generateHtmlReport(
    rankedProperties: RankedProperty[],
    runInfo: {
        runId: string;
        fileName: string;
        date: string;
        totalProperties: number;
        filteredCount: number;
    }
): string {
    const propertyCards = rankedProperties
        .map((rp, i) => generatePropertyCard(rp, i))
        .join('\n');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Section 8 BRRRR Analysis Report</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #f5f5f5;
      color: #333;
      line-height: 1.6;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    
    .report-header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: white;
      padding: 40px;
      border-radius: 12px;
      margin-bottom: 30px;
    }
    
    .report-header h1 {
      font-size: 2rem;
      margin-bottom: 10px;
    }
    
    .report-meta {
      display: flex;
      gap: 30px;
      margin-top: 20px;
      font-size: 0.9rem;
      opacity: 0.9;
    }
    
    .summary-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    
    .stat-card {
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      text-align: center;
    }
    
    .stat-value {
      font-size: 2rem;
      font-weight: bold;
      color: #1a1a2e;
    }
    
    .stat-label {
      color: #666;
      font-size: 0.9rem;
    }
    
    .property-card {
      background: white;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    
    .property-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    
    .rank {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 1.2rem;
    }
    
    .score {
      background: #e8f5e9;
      color: #2e7d32;
      padding: 8px 16px;
      border-radius: 20px;
      font-weight: 600;
    }
    
    .property-address {
      font-size: 1.3rem;
      color: #1a1a2e;
      margin-bottom: 8px;
    }
    
    .zillow-link {
      color: #006aff;
      text-decoration: none;
      font-size: 0.9rem;
    }
    
    .zillow-link:hover {
      text-decoration: underline;
    }
    
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin: 20px 0;
      padding: 16px;
      background: #f8f9fa;
      border-radius: 8px;
    }
    
    .metric {
      text-align: center;
    }
    
    .metric-label {
      display: block;
      font-size: 0.8rem;
      color: #666;
      margin-bottom: 4px;
    }
    
    .metric-value {
      font-size: 1.1rem;
      font-weight: 600;
      color: #1a1a2e;
    }
    
    .key-metrics {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin: 20px 0;
    }
    
    .key-metric {
      text-align: center;
      padding: 16px;
      border-radius: 8px;
      background: #f0f0f0;
    }
    
    .key-metric.good {
      background: #e8f5e9;
    }
    
    .key-metric.warning {
      background: #fff3e0;
    }
    
    .key-metric.poor {
      background: #ffebee;
    }
    
    .key-metric-value {
      display: block;
      font-size: 1.5rem;
      font-weight: bold;
    }
    
    .good .key-metric-value { color: #2e7d32; }
    .warning .key-metric-value { color: #f57c00; }
    .poor .key-metric-value { color: #c62828; }
    
    .key-metric-label {
      font-size: 0.85rem;
      color: #666;
    }
    
    .forecast-section, .monthly-breakdown {
      margin-top: 24px;
    }
    
    .forecast-section h4, .monthly-breakdown h4 {
      font-size: 1rem;
      color: #1a1a2e;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 2px solid #e0e0e0;
    }
    
    .forecast-table {
      width: 100%;
      border-collapse: collapse;
    }
    
    .forecast-table th, .forecast-table td {
      padding: 12px;
      text-align: right;
      border-bottom: 1px solid #e0e0e0;
    }
    
    .forecast-table th {
      background: #f8f9fa;
      font-weight: 600;
      color: #1a1a2e;
    }
    
    .forecast-table td:first-child {
      text-align: left;
      font-weight: 500;
    }
    
    .breakdown-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 12px;
    }
    
    .breakdown-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 12px;
      background: #f8f9fa;
      border-radius: 8px;
      font-size: 0.9rem;
    }
    
    .breakdown-item.total {
      background: #1a1a2e;
      color: white;
    }
    
    .footer {
      text-align: center;
      padding: 40px;
      color: #666;
      font-size: 0.9rem;
    }
    
    @media print {
      .property-card {
        break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="report-header">
      <h1>Section 8 BRRRR Analysis Report</h1>
      <p>Top ${rankedProperties.length} Investment Opportunities</p>
      <div class="report-meta">
        <span>📄 Source: ${runInfo.fileName}</span>
        <span>📅 Generated: ${runInfo.date}</span>
        <span>🔢 Run ID: ${runInfo.runId.substring(0, 8)}</span>
      </div>
    </div>
    
    <div class="summary-stats">
      <div class="stat-card">
        <div class="stat-value">${runInfo.totalProperties}</div>
        <div class="stat-label">Properties Extracted</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${runInfo.filteredCount}</div>
        <div class="stat-label">Passed Filters</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${rankedProperties.length}</div>
        <div class="stat-label">Top Deals</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${rankedProperties.length > 0 ? rankedProperties[0].score.toFixed(0) : 'N/A'}</div>
        <div class="stat-label">Best Score</div>
      </div>
    </div>
    
    ${propertyCards}
    
    <div class="footer">
      <p>Generated by Section 8 BRRRR Deal Analyzer</p>
      <p>This report is for informational purposes only. Always conduct your own due diligence.</p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Generate PDF from HTML
 */
export async function generatePdfReport(
    htmlContent: string,
    outputPath: string
): Promise<void> {
    const browser = await getBrowser();
    const page = await browser.newPage();

    await page.setContent(htmlContent, { waitUntil: 'networkidle' });

    await page.pdf({
        path: outputPath,
        format: 'A4',
        printBackground: true,
        margin: {
            top: '20px',
            bottom: '20px',
            left: '20px',
            right: '20px',
        },
    });

    await page.close();
}

/**
 * Generate and save both HTML and PDF reports
 */
export async function generateReports(
    rankedProperties: RankedProperty[],
    runInfo: {
        runId: string;
        fileName: string;
        date: string;
        totalProperties: number;
        filteredCount: number;
    },
    outputDir: string
): Promise<{ htmlPath: string; pdfPath: string }> {
    // Ensure output directory exists
    await fs.mkdir(outputDir, { recursive: true });

    const baseName = `report_${runInfo.runId.substring(0, 8)}_${new Date().toISOString().split('T')[0]}`;
    const htmlPath = path.join(outputDir, `${baseName}.html`);
    const pdfPath = path.join(outputDir, `${baseName}.pdf`);

    // Generate HTML
    const html = generateHtmlReport(rankedProperties, runInfo);
    await fs.writeFile(htmlPath, html, 'utf-8');

    // Generate PDF
    await generatePdfReport(html, pdfPath);

    return { htmlPath, pdfPath };
}
