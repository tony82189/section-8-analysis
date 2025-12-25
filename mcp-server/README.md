# Section 8 Analyzer MCP Server

This MCP (Model Context Protocol) server provides tools for checking property market status on Zillow.

## Overview

Since automated Zillow scraping is blocked by anti-bot measures, this MCP server enables a **semi-automated workflow** where you use Claude Desktop or Claude Chrome Extension to check property status manually.

## Installation

### 1. Build the MCP Server

```bash
npm run build:mcp
```

This compiles the TypeScript to `dist/mcp-server/index.js`.

### 2. Configure Claude Desktop

Add the following to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "section8-analyzer": {
      "command": "node",
      "args": ["/path/to/section8-analyzer/dist/mcp-server/index.js"]
    }
  }
}
```

Replace `/path/to/section8-analyzer` with the actual path to this project.

### 3. Restart Claude Desktop

After adding the configuration, restart Claude Desktop to load the MCP server.

## Available Tools

### `construct_zillow_url`

Constructs a Zillow search URL from address components.

**Parameters:**
- `address` (required): Street address (e.g., "123 Main St")
- `city` (required): City name
- `state` (required): State (2-letter code or full name)
- `zip` (optional): ZIP code

**Example:**
```
Construct a Zillow URL for 123 Main St, Memphis, TN
```

### `parse_market_status`

Parses market status from user-provided text (e.g., copied from Zillow page).

**Parameters:**
- `text` (required): The text to parse for status indicators

**Returns:** One of: `active`, `pending`, `sold`, `off-market`, or `unknown`

**Example:**
```
Parse the market status from: "This home is currently listed for sale at $150,000"
```

## Workflow

### Using Claude Desktop with MCP

1. **Upload PDF** - Start the analysis pipeline in the web app
2. **Pipeline pauses at Step 5** - Properties are extracted but status is "Unknown"
3. **Open Review page** - Go to `/run/[id]/review`
4. **For each property:**
   - Click "Copy Address" button
   - In Claude Desktop, ask: "Check Zillow status for [paste address]"
   - Claude will use `construct_zillow_url` to build the URL
   - Visit the URL and report the status
   - Select the status from the dropdown in the web app

### Using Claude Chrome Extension

1. **Install Claude in Chrome** - Available for Pro/Max/Team subscribers
2. **For each property:**
   - Click "Copy Address" in the Review page
   - In Chrome, open Claude extension and say:
     "Go to Zillow and check if [paste address] is for sale"
   - Claude navigates to Zillow and reads the page
   - Update the status dropdown in the web app

## Example Prompts

### Quick Status Check
```
Check the Zillow status for 1234 Elm Street, Memphis, TN 38116
```

### Batch Check (with Chrome Extension)
```
I need to check the status of these properties on Zillow:
1. 1234 Elm St, Memphis, TN
2. 5678 Oak Ave, Memphis, TN
3. 9012 Pine Rd, Memphis, TN

For each one, go to Zillow and tell me if it's:
- Active (for sale)
- Pending (under contract)
- Sold
- Off market
```

### Parse Copied Text
```
Parse this text from Zillow:
"Sold: $125,000 on 12/15/2024"
```

## Troubleshooting

### MCP Server Not Loading
1. Check the path in `claude_desktop_config.json` is correct
2. Ensure `npm run build:mcp` completed successfully
3. Check for syntax errors in the config JSON
4. Restart Claude Desktop

### Tools Not Available
1. Type `/mcp` in Claude Desktop to see connected servers
2. The "section8-analyzer" server should be listed
3. If not, check the config and restart

### Zillow Blocking Access
If Claude Chrome Extension encounters CAPTCHAs:
1. Claude will pause and ask you to solve it
2. Complete the CAPTCHA manually
3. Tell Claude to continue

## Technical Details

- **Protocol:** MCP (Model Context Protocol)
- **Transport:** stdio (standard input/output)
- **SDK:** @modelcontextprotocol/sdk v1.25.1
- **Build:** TypeScript → CommonJS (ES2022)

## Files

```
mcp-server/
├── index.ts          # Main server implementation
├── tsconfig.json     # TypeScript config
└── README.md         # This file

dist/mcp-server/
└── index.js          # Compiled output (after npm run build:mcp)
```
