import OpenAI from 'openai';
import { getSetting } from '../db/sqlite';
import type { Property } from '../types';

let openai: OpenAI | null = null;

// Rate limiting delay between API calls (ms)
const API_CALL_DELAY = 200;

export function getOpenAIClient(): OpenAI | null {
    if (openai) return openai;

    const apiKey = getSetting('llmApiKey') || process.env.OPENAI_API_KEY;

    if (!apiKey) {
        console.warn('OpenAI API key not found in settings or env');
        return null;
    }

    openai = new OpenAI({ apiKey });
    return openai;
}

interface OpenAIUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
}

export async function extractPropertiesWithLLM(
    imageBuffer: Buffer,
    pageNumber: number
): Promise<{ properties: Partial<Property>[]; usage: OpenAIUsage | null }> {
    const client = getOpenAIClient();
    if (!client) {
        throw new Error('OpenAI client not configured');
    }

    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:image/png;base64,${base64Image}`;

    const prompt = `
You are extracting property data from a Section 8 investment listing PDF.

=== CRITICAL INSTRUCTIONS ===
1. Process each property INDEPENDENTLY - never mix data between properties
2. Report CONFIDENCE (0-100) for askingPrice and rehabNeeded fields
3. If you cannot clearly read a value, use null
4. Read EXACTLY what is shown - do not guess or infer values

=== CONFIDENCE SCORING ===
- 90-100: I can clearly read this exact value in the image
- 70-89: I found a value but text is slightly unclear
- 50-69: I'm making an educated guess based on context
- 0-49: I cannot find or read this value (use null)

=== ADDRESS EXTRACTION ===
Properties may show address in TWO ways:
1. Separate address line: "1611 15th Ave N"
2. ONLY in Zillow URL: "https://www.zillow.com/homedetails/1340-43rd-Street-Ensley-Birmingham-AL-35208/..."

If ONLY a Zillow URL is shown (no separate address), PARSE THE ADDRESS FROM THE URL:
- URL: /homedetails/1340-43rd-Street-Ensley-Birmingham-AL-35208/...
- Extract: address="1340 43rd Street", city="Ensley", zip="35208"

=== RANGE VALUES ===
Rent and ARV often show ranges. Capture BOTH min and max values:
- "$1,300-$1,400" → rentMin=1300, rentMax=1400
- "$135k-$145k" → arvMin=135000, arvMax=145000
- Single value "$1,400" → rentMin=1400, rentMax=1400 (same value for both)

=== LOCATION CONTEXT ===
All properties are in ALABAMA (state: "AL"), mostly Birmingham metro area.
Default city to "Birmingham" if not explicitly shown.

=== FIELDS TO EXTRACT ===
- address: Street address (from text line OR parsed from Zillow URL)
- city: City name (from text, from Zillow URL, or default "Birmingham")
- state: Always "AL"
- zip: ZIP code (from text or Zillow URL)
- askingPrice: Dollar amount. "$110k" = 110000
- askingPriceConfidence: 0-100 confidence score
- suggestedOffer: Offer price. "$65k" = 65000
- rentMin: Lower rent value
- rentMax: Higher rent value (or same as min if single value)
- rehabNeeded: Rehab cost. "44k" = 44000, "$0" = 0
- rehabConfidence: 0-100 confidence score
- arvMin: Lower ARV value
- arvMax: Higher ARV value
- bedrooms: Number (look for "FOUR BEDROOM" = 4, "3 bed" = 3)
- bathrooms: Number (look for "TWO BATHROOM" = 2, "2 bath" = 2)
- zillowUrl: Full Zillow URL exactly as shown
- section8Tenant: true if "Section 8 Tenant" mentioned

=== EXAMPLE FROM YOUR PDF ===
Image shows:
  "1611 15th Ave N
   Asking Price: $110k
   Section 8 Tenant Application Accepted
   Rehab Needed: $0"

Extract as:
{
  "address": "1611 15th Ave N",
  "city": "Birmingham",
  "state": "AL",
  "askingPrice": 110000,
  "askingPriceConfidence": 100,
  "suggestedOffer": null,
  "rentMin": null,
  "rentMax": null,
  "rehabNeeded": 0,
  "rehabConfidence": 100,
  "section8Tenant": true
}

=== SCANNING INSTRUCTIONS ===
- Scan the ENTIRE image including all columns
- Count ALL properties - pages often have 10-15+ properties
- Each Zillow link or address header indicates a separate property
- Read the ACTUAL values shown, do not confuse values between properties

Return ONLY valid JSON:
{
  "properties": [...],
  "pagePropertyCount": <number>
}
`;

    try {
        const response = await client.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
                    ],
                },
            ],
            max_tokens: 8192,
            temperature: 0,
            response_format: { type: 'json_object' },
        });

        const content = response.choices[0].message.content || '{}';
        let parsed: Record<string, unknown> = {};

        try {
            parsed = JSON.parse(content);
        } catch {
            // Try to fix common JSON markdown issues
            const cleanJson = content.replace(/```json\n|\n```/g, '');
            parsed = JSON.parse(cleanJson);
        }

        // Handle wrap in "properties" key or raw array
        const rawList: Record<string, unknown>[] = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed.properties) ? parsed.properties : []);

        const properties: Partial<Property>[] = rawList.map((item: Record<string, unknown>) => {
            // Parse numeric values from potentially string inputs
            const parseNumber = (val: unknown): number | null => {
                if (typeof val === 'number') return val;
                if (typeof val === 'string') {
                    const num = parseFloat(val.replace(/[^0-9.]/g, ''));
                    return isNaN(num) ? null : num;
                }
                return null;
            };

            // Handle range fields - use max value for backwards compatibility with 'rent' and 'arv'
            const rentMin = parseNumber(item.rentMin);
            const rentMax = parseNumber(item.rentMax);
            const arvMin = parseNumber(item.arvMin);
            const arvMax = parseNumber(item.arvMax);

            // Get confidence scores
            const askingPriceConfidence = parseNumber(item.askingPriceConfidence) ?? 0;
            const rehabConfidence = parseNumber(item.rehabConfidence) ?? 0;

            // Flag for manual review if low confidence on critical fields
            const needsReview = askingPriceConfidence < 70 || rehabConfidence < 70;

            return {
                sourcePage: pageNumber,
                sourceChunk: 'llm-extraction',
                address: typeof item.address === 'string' ? item.address : null,
                city: typeof item.city === 'string' ? item.city : null,
                state: typeof item.state === 'string' ? item.state : null,
                zip: typeof item.zip === 'string' ? item.zip : null,
                askingPrice: parseNumber(item.askingPrice),
                suggestedOffer: parseNumber(item.suggestedOffer),
                // Use rentMax for backwards compat, fall back to old 'rent' field
                rent: rentMax ?? parseNumber(item.rent),
                rentMin: rentMin,
                rentMax: rentMax,
                rehabNeeded: parseNumber(item.rehabNeeded),
                // Use arvMax for backwards compat, fall back to old 'arv' field
                arv: arvMax ?? parseNumber(item.arv),
                arvMin: arvMin,
                arvMax: arvMax,
                bedrooms: parseNumber(item.bedrooms),
                bathrooms: parseNumber(item.bathrooms),
                sqft: parseNumber(item.sqft),
                zillowUrl: typeof item.zillowUrl === 'string' ? item.zillowUrl : null,
                occupied: typeof item.occupied === 'boolean' ? item.occupied : null,
                section8Tenant: typeof item.section8Tenant === 'boolean' ? item.section8Tenant : null,
                needsManualReview: needsReview,
                reviewNotes: needsReview ? `Low confidence: asking=${askingPriceConfidence}%, rehab=${rehabConfidence}%` : null,
            };
        });

        return {
            properties,
            usage: response.usage ?? null,
        };

    } catch (error) {
        console.error('OpenAI extraction error:', error);
        throw error;
    }
}

/**
 * Extract properties with retry logic and exponential backoff
 */
export async function extractPropertiesWithRetry(
    imageBuffer: Buffer,
    pageNumber: number,
    maxRetries = 3
): Promise<{ properties: Partial<Property>[]; usage: OpenAIUsage | null }> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            // Add delay between attempts (and between pages)
            if (attempt > 0) {
                const backoffDelay = API_CALL_DELAY * Math.pow(2, attempt);
                console.log(`[OpenAI] Retry attempt ${attempt + 1}/${maxRetries} after ${backoffDelay}ms`);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
            }

            const result = await extractPropertiesWithLLM(imageBuffer, pageNumber);

            // Add small delay after successful call to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, API_CALL_DELAY));

            return result;
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.error(`[OpenAI] Attempt ${attempt + 1} failed:`, lastError.message);

            // Don't retry on auth errors
            if (lastError.message.includes('401') || lastError.message.includes('invalid_api_key')) {
                throw lastError;
            }
        }
    }

    throw lastError || new Error('All retry attempts failed');
}

/**
 * Verify extracted properties against the image.
 * Used as a second pass to catch hallucinations.
 */
export async function verifyExtractedProperties(
    properties: Partial<Property>[],
    imageBuffer: Buffer,
    pageNumber: number
): Promise<{ corrections: Array<{ address: string; field: string; extracted: unknown; actual: unknown; reason: string }> }> {
    const client = getOpenAIClient();
    if (!client) return { corrections: [] };

    // Only verify properties that need it
    if (properties.length === 0) return { corrections: [] };

    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:image/png;base64,${base64Image}`;

    // Build verification request for suspicious properties
    const propsToVerify = properties.map((p, i) => ({
        index: i,
        address: p.address,
        askingPrice: p.askingPrice,
        rent: p.rent,
        rehabNeeded: p.rehabNeeded,
    }));

    const prompt = `
You are VERIFYING extracted property data. Look at the image and check if these values are CORRECT.

Properties extracted from page ${pageNumber}:
${JSON.stringify(propsToVerify, null, 2)}

For EACH property, find it in the image by its ADDRESS and verify:
1. Is the asking price correct? Look for "Asking Price: $XXk"
2. Is the rent correct? Look for "Section 8 Rent: $X,XXX"
3. Is the rehab correct? Look for "Rehab Needed: $XXk" or "$0"

Return corrections ONLY for values that are WRONG:
{
  "corrections": [
    {
      "address": "1611 15th Ave N",
      "field": "askingPrice",
      "extracted": 75000,
      "actual": 110000,
      "reason": "Image shows 'Asking Price: $110k' not $75k"
    }
  ]
}

If all values are correct, return: { "corrections": [] }

IMPORTANT: Only flag CLEAR errors where you can see a different value in the image.
`;

    try {
        const response = await client.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
                    ],
                },
            ],
            max_tokens: 2048,
            temperature: 0,
            response_format: { type: 'json_object' },
        });

        const content = response.choices[0].message.content || '{}';
        const parsed = JSON.parse(content);

        return {
            corrections: Array.isArray(parsed.corrections) ? parsed.corrections : [],
        };
    } catch (error) {
        console.error('[OpenAI] Verification error:', error);
        return { corrections: [] };
    }
}
