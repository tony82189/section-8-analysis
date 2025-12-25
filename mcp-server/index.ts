#!/usr/bin/env node
/**
 * MCP Server for Section 8 Property Market Status Checking
 *
 * This server provides tools for Claude to help check property market status
 * by constructing Zillow URLs and parsing status from user-provided text.
 *
 * Tools:
 * - construct_zillow_url: Builds a Zillow search URL from address components
 * - parse_market_status: Extracts structured status from text description
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Create MCP server instance
const server = new Server(
    { name: 'section8-market-status', version: '1.0.0' },
    { capabilities: { tools: {} } }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'construct_zillow_url',
            description: 'Constructs a Zillow URL from a property address. Use this to get the URL that the user can visit to check the market status. The user should visit this URL in their browser and report back what they see.',
            inputSchema: {
                type: 'object',
                properties: {
                    address: {
                        type: 'string',
                        description: 'Street address (e.g., "123 Main St" or "1340 43rd Street")'
                    },
                    city: {
                        type: 'string',
                        description: 'City name (e.g., "Birmingham")'
                    },
                    state: {
                        type: 'string',
                        description: '2-letter state code (e.g., "AL")'
                    },
                },
                required: ['address', 'city', 'state'],
            },
        },
        {
            name: 'parse_market_status',
            description: 'Parses market status from text the user provides after checking the property on Zillow. Returns a structured status object with status type and details.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description: 'Raw text from Zillow page or user description of what they see (e.g., "It says Sold on Dec 15, 2024" or "The listing shows For Sale at $85,000")'
                    },
                },
                required: ['text'],
            },
        },
    ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'construct_zillow_url') {
        const { address, city, state } = args as {
            address: string;
            city: string;
            state: string;
        };

        // Build URL-friendly slug from address components
        // Format: "123-main-st-birmingham-al"
        const slug = `${address}-${city}-${state}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with hyphens
            .replace(/-+/g, '-')           // Collapse multiple hyphens
            .replace(/^-|-$/g, '');        // Trim leading/trailing hyphens

        // Zillow search URL format that works for address lookups
        const url = `https://www.zillow.com/homes/${slug}_rb/`;

        // Also provide a direct Google search as backup
        const googleSearch = `https://www.google.com/search?q=${encodeURIComponent(`${address} ${city} ${state} zillow`)}`;

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    zillowUrl: url,
                    googleSearchUrl: googleSearch,
                    address,
                    city,
                    state,
                    instructions: 'Please visit the Zillow URL to check the property status. If that doesn\'t work, try the Google search URL to find the correct Zillow listing.',
                }, null, 2),
            }],
        };
    }

    if (name === 'parse_market_status') {
        const { text } = args as { text: string };
        const lower = text.toLowerCase();

        type MarketStatus = 'active' | 'pending' | 'sold' | 'off-market' | 'unknown';
        let status: MarketStatus = 'unknown';
        let details = '';

        // Check for sold indicators (most specific first)
        const soldPatterns = [
            /sold\s+(?:on\s+)?(\w+\s+\d{1,2},?\s+\d{4})/i,           // "Sold on December 15, 2024"
            /sold\s+(?:on\s+)?(\d{1,2}\/\d{1,2}\/\d{2,4})/i,         // "Sold on 12/15/2024"
            /sold\s+for\s+\$?([\d,]+)/i,                              // "Sold for $85,000"
            /(?:was\s+)?sold\s+(\w+\s+\d{4})/i,                       // "Sold December 2024"
        ];

        for (const pattern of soldPatterns) {
            const match = text.match(pattern);
            if (match) {
                status = 'sold';
                details = match[0];
                break;
            }
        }

        // If no specific sold match, check for general sold keywords
        if (status === 'unknown') {
            if (
                lower.includes('sold') ||
                lower.includes('was sold') ||
                lower.includes('sold for') ||
                lower.includes('recently sold')
            ) {
                status = 'sold';
                details = 'Sold (date unknown)';
            }
        }

        // Check for pending/under contract
        if (status === 'unknown') {
            if (
                lower.includes('pending') ||
                lower.includes('under contract') ||
                lower.includes('contingent') ||
                lower.includes('sale pending') ||
                lower.includes('offer accepted')
            ) {
                status = 'pending';
                details = 'Under contract';
            }
        }

        // Check for active/for sale status
        if (status === 'unknown') {
            const activePatterns = [
                /for sale/i,
                /active listing/i,
                /list price/i,
                /asking\s+(?:price\s+)?\$?([\d,]+)/i,
                /listed\s+(?:at|for)\s+\$?([\d,]+)/i,
                /\$[\d,]+\s*(?:asking|list)/i,
            ];

            for (const pattern of activePatterns) {
                const match = text.match(pattern);
                if (match) {
                    status = 'active';
                    details = match[0];
                    break;
                }
            }

            // General active keywords
            if (status === 'unknown' && (
                lower.includes('for sale') ||
                lower.includes('active') ||
                lower.includes('available')
            )) {
                status = 'active';
                details = 'Currently for sale';
            }
        }

        // Check for off-market
        if (status === 'unknown') {
            if (
                lower.includes('off market') ||
                lower.includes('off-market') ||
                lower.includes('not currently listed') ||
                lower.includes('no longer listed') ||
                lower.includes('not for sale') ||
                lower.includes('not available') ||
                lower.includes('removed')
            ) {
                status = 'off-market';
                details = 'Not currently listed';
            }
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    status,
                    details: details || `Unable to determine status from: "${text.substring(0, 100)}..."`,
                    confidence: status === 'unknown' ? 'low' : 'high',
                }, null, 2),
            }],
        };
    }

    throw new Error(`Unknown tool: ${name}`);
});

// Start server with stdio transport
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Section 8 Market Status MCP Server running on stdio');
}

main().catch((error) => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
});
