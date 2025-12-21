import OpenAI from 'openai';
import { getSetting } from '../db/sqlite';
import type { Property } from '../types';

let openai: OpenAI | null = null;

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

export async function extractPropertiesWithLLM(
    imageBuffer: Buffer,
    pageNumber: number
): Promise<{ properties: Partial<Property>[]; usage: any }> {
    const client = getOpenAIClient();
    if (!client) {
        throw new Error('OpenAI client not configured');
    }

    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:image/png;base64,${base64Image}`;

    const prompt = `
    Analyze this image of a real estate property list (likely Section 8 / investment properties).
    Extract all property listings found on this page into a JSON array.
    
    For each property, extract:
    - address (street, city, state, zip)
    - askingPrice (number)
    - suggestedOffer (number, if present)
    - rent (estimated monthly rent, number. If range, use average)
    - rehabNeeded (number, e.g. "3k" -> 3000)
    - arv (number, Estimated ARV)
    - zillowUrl (full URL if present)
    - occupied (boolean, true if "Occupied" mentioned)
    - section8Tenant (boolean, true if "Section 8" tenant mentioned)
    
    Return ONLY valid JSON array. No markdown formatting.
    Example:
    [
      {
        "address": "123 Main St",
        "city": "Birmingham",
        "state": "AL",
        "zip": "35205",
        "askingPrice": 100000,
        "rehabNeeded": 5000,
        ...
      }
    ]
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
            max_tokens: 4096,
            temperature: 0,
            response_format: { type: 'json_object' },
        });

        const content = response.choices[0].message.content || '{}';
        let parsed: any = {};

        try {
            parsed = JSON.parse(content);
        } catch (e) {
            // Try to fix common JSON markdown issues
            const cleanJson = content.replace(/```json\n|\n```/g, '');
            parsed = JSON.parse(cleanJson);
        }

        // Handle wrap in "properties" key or raw array
        const rawList = Array.isArray(parsed) ? parsed : (parsed.properties || []);

        const properties: Partial<Property>[] = rawList.map((item: any) => ({
            sourcePage: pageNumber,
            sourceChunk: 'llm-extraction',
            address: item.address ? `${item.address} ${item.city || ''} ${item.state || ''}`.trim() : null, // Combine if needed or check schema
            // Actually strictly my schema wants address separated from city/state if possible
            // But my parser does: address = street. city, state, zip are separate.
            // Let's trust field mapping:
            ...item,
            // Normalize numbers
            askingPrice: typeof item.askingPrice === 'string' ? parseFloat(item.askingPrice.replace(/[^0-9.]/g, '')) : item.askingPrice,
            rent: typeof item.rent === 'string' ? parseFloat(item.rent.replace(/[^0-9.]/g, '')) : item.rent,
        }));

        return {
            properties,
            usage: response.usage,
        };

    } catch (error) {
        console.error('OpenAI extraction error:', error);
        throw error;
    }
}
