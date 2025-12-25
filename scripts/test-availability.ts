/**
 * Test script for availability checker
 * Run with: npx tsx scripts/test-availability.ts
 */

import { checkPropertyAvailability, closeSearchBrowser } from '../lib/availability/checker';
import { closeBrowser as closeZillowBrowser } from '../lib/zillow/scraper';

async function test() {
    console.log('Testing availability check for 1509 20th Pl SW (known sold property)...\n');

    try {
        const result = await checkPropertyAvailability(
            'https://www.zillow.com/homedetails/1509-20th-Pl-SW-Birmingham-AL-35211/1008524_zpid/',
            '1509 20th Pl Sw',
            'Birmingham',
            'AL'
        );

        console.log('=== RESULT ===');
        console.log('Status:', result.status);
        console.log('Source:', result.source);
        console.log('Details:', result.details || 'N/A');
        console.log('Last Checked:', result.lastChecked);

        if (result.status === 'sold') {
            console.log('\n✅ SUCCESS: Property correctly identified as SOLD');
        } else if (result.status === 'needs-review' || result.status === 'unknown') {
            console.log('\n⚠️  WARNING: Could not determine status - check if scraping is blocked');
        } else {
            console.log('\n❌ UNEXPECTED: Status is', result.status);
        }

    } catch (err) {
        console.error('Error:', err);
    } finally {
        // Cleanup browsers
        await closeSearchBrowser();
        await closeZillowBrowser();
    }
}

test().then(() => process.exit(0)).catch(() => process.exit(1));
