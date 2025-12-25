export type ParsedStatus = 'active' | 'pending' | 'sold' | 'off-market' | 'unknown';

export interface StatusResult {
    index: number; // -1 if no index was found (address-only format)
    address: string;
    status: ParsedStatus;
    details?: string;
    raw: string;
}

/**
 * Normalize an address for comparison
 * Removes punctuation, extra spaces, and converts to lowercase
 */
export function normalizeAddress(address: string): string {
    return address
        .toLowerCase()
        .replace(/[,.]+/g, ' ')  // Replace commas and periods with spaces
        .replace(/\s+/g, ' ')     // Collapse multiple spaces
        .trim();
}

export interface ParseResult {
    results: StatusResult[];
    unparsedLines: string[];
    summary: {
        total: number;
        active: number;
        pending: number;
        sold: number;
        offMarket: number;
        notFound: number;
    };
}

/**
 * Parse Claude's response containing property availability statuses
 */
export function parseClaudeResponse(response: string): ParseResult {
    const lines = response.split('\n').filter(line => line.trim());
    const results: StatusResult[] = [];
    const unparsedLines: string[] = [];

    for (const line of lines) {
        const result = parseLine(line);
        if (result) {
            results.push(result);
        } else if (line.trim() && !isHeaderOrInstructionLine(line)) {
            unparsedLines.push(line);
        }
    }

    // Calculate summary
    const summary = {
        total: results.length,
        active: results.filter(r => r.status === 'active').length,
        pending: results.filter(r => r.status === 'pending').length,
        sold: results.filter(r => r.status === 'sold').length,
        offMarket: results.filter(r => r.status === 'off-market').length,
        notFound: results.filter(r => r.status === 'unknown').length,
    };

    return { results, unparsedLines, summary };
}

/**
 * Parse a single line from Claude's response
 * Supports both numbered format (1. Address | STATUS) and address-only format (Address | STATUS)
 */
function parseLine(line: string): StatusResult | null {
    // Patterns WITH line numbers (original formats)
    const numberedPatterns = [
        // Standard format: "1. Address | STATUS | details"
        /^(\d+)[.\)]\s*(.+?)\s*\|\s*(ACTIVE|PENDING|SOLD|OFF-MARKET|OFF MARKET|NOT-FOUND|NOT FOUND|UNKNOWN)\s*(?:\|\s*(.*))?$/i,
        // Colon format: "1. Address: STATUS - details"
        /^(\d+)[.\)]\s*(.+?):\s*(ACTIVE|PENDING|SOLD|OFF-MARKET|OFF MARKET|NOT-FOUND|NOT FOUND|UNKNOWN)\s*(?:-\s*(.*))?$/i,
        // Dash format: "1. Address - STATUS (details)"
        /^(\d+)[.\)]\s*(.+?)\s*-\s*(ACTIVE|PENDING|SOLD|OFF-MARKET|OFF MARKET|NOT-FOUND|NOT FOUND|UNKNOWN)\s*(?:\((.+)\))?$/i,
    ];

    // Try numbered patterns first
    for (const pattern of numberedPatterns) {
        const match = line.match(pattern);
        if (match) {
            return {
                index: parseInt(match[1]),
                address: match[2].trim(),
                status: mapStatus(match[3]),
                details: match[4]?.trim() || undefined,
                raw: line,
            };
        }
    }

    // Patterns WITHOUT line numbers (for Claude Chrome Extension copy issue)
    const unnumberedPatterns = [
        // Address | STATUS | details (most common from Chrome Extension)
        /^(.+?)\s*\|\s*(ACTIVE|PENDING|SOLD|OFF-MARKET|OFF MARKET|NOT-FOUND|NOT FOUND|UNKNOWN)\s*\|\s*(.+)$/i,
        // Address | STATUS (no details)
        /^(.+?)\s*\|\s*(ACTIVE|PENDING|SOLD|OFF-MARKET|OFF MARKET|NOT-FOUND|NOT FOUND|UNKNOWN)\s*$/i,
        // Address: STATUS - details
        /^(.+?):\s*(ACTIVE|PENDING|SOLD|OFF-MARKET|OFF MARKET|NOT-FOUND|NOT FOUND|UNKNOWN)\s*-\s*(.+)$/i,
        // Address - STATUS (details)
        /^(.+?)\s*-\s*(ACTIVE|PENDING|SOLD|OFF-MARKET|OFF MARKET|NOT-FOUND|NOT FOUND|UNKNOWN)\s*\((.+)\)$/i,
    ];

    // Try unnumbered patterns
    for (const pattern of unnumberedPatterns) {
        const match = line.match(pattern);
        if (match) {
            return {
                index: -1, // No index available
                address: match[1].trim(),
                status: mapStatus(match[2]),
                details: match[3]?.trim() || undefined,
                raw: line,
            };
        }
    }

    return null;
}

/**
 * Map raw status string to normalized status
 */
function mapStatus(raw: string): ParsedStatus {
    const normalized = raw.toUpperCase().replace(/\s+/g, '-');

    switch (normalized) {
        case 'ACTIVE':
            return 'active';
        case 'PENDING':
            return 'pending';
        case 'SOLD':
            return 'sold';
        case 'OFF-MARKET':
            return 'off-market';
        case 'NOT-FOUND':
        case 'UNKNOWN':
        default:
            return 'unknown';
    }
}

/**
 * Check if line is a header or instruction (not property data)
 */
function isHeaderOrInstructionLine(line: string): boolean {
    const lower = line.toLowerCase().trim();
    return (
        lower.startsWith('here') ||
        lower.startsWith('i ') ||
        lower.startsWith('let me') ||
        lower.startsWith('checking') ||
        lower.startsWith('based on') ||
        lower.startsWith('results') ||
        lower.startsWith('property') ||
        lower.includes('status check') ||
        lower.includes('the following') ||
        lower === ''
    );
}

/**
 * Validate that the response contains the expected number of results
 */
export function validateResults(
    results: StatusResult[],
    expectedCount: number
): { valid: boolean; message: string } {
    if (results.length === 0) {
        return {
            valid: false,
            message: 'No property statuses found in the response. Make sure Claude\'s response follows the format: "Address | STATUS | details"',
        };
    }

    if (results.length < expectedCount) {
        return {
            valid: true,
            message: `Found ${results.length} of ${expectedCount} expected properties. Some may not have been parsed.`,
        };
    }

    return {
        valid: true,
        message: `Successfully parsed ${results.length} property statuses.`,
    };
}
