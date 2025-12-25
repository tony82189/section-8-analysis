import { NextRequest, NextResponse } from 'next/server';
import { getPropertiesByRunId, updatePropertyStatus, type MarketStatus } from '@/lib/db/sqlite';
import { parseClaudeResponse, validateResults, normalizeAddress } from '@/lib/availability/response-parser';
import { generatePropertyIndexMap, getPropertiesNeedingCheck, generateAddressMap } from '@/lib/availability/prompt-generator';

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { runId, response } = body;

        if (!runId) {
            return NextResponse.json(
                { success: false, error: 'Run ID is required' },
                { status: 400 }
            );
        }

        if (!response || typeof response !== 'string') {
            return NextResponse.json(
                { success: false, error: 'Response text is required' },
                { status: 400 }
            );
        }

        // Get properties for this run
        const allProperties = getPropertiesByRunId(runId);
        if (allProperties.length === 0) {
            return NextResponse.json(
                { success: false, error: 'No properties found for this run' },
                { status: 404 }
            );
        }

        // Get properties that need checking (same filter as prompt generator)
        const propertiesNeedingCheck = getPropertiesNeedingCheck(allProperties);

        // Generate both index map and address map for matching
        const indexMap = generatePropertyIndexMap(propertiesNeedingCheck);
        const addressMap = generateAddressMap(propertiesNeedingCheck);

        // Parse Claude's response
        const parseResult = parseClaudeResponse(response);

        // Validate results
        const validation = validateResults(parseResult.results, propertiesNeedingCheck.length);

        // Update properties with parsed statuses
        const updates: Array<{ id: string; status: MarketStatus; details?: string; matchedBy: 'address' | 'index' }> = [];
        const failures: Array<{ index: number; address: string; reason: string }> = [];

        for (const result of parseResult.results) {
            let propertyId: string | undefined;
            let matchedBy: 'address' | 'index' = 'address';

            // Try address match first (works for both numbered and unnumbered responses)
            const normalizedResultAddress = normalizeAddress(result.address);
            propertyId = addressMap.get(normalizedResultAddress);

            // Fall back to index match if address doesn't match and we have an index
            if (!propertyId && result.index > 0) {
                propertyId = indexMap.get(result.index);
                matchedBy = 'index';
            }

            if (!propertyId) {
                failures.push({
                    index: result.index,
                    address: result.address,
                    reason: result.index > 0
                        ? `No property found for index ${result.index} or address "${result.address}"`
                        : `No property found for address "${result.address}"`,
                });
                continue;
            }

            // Update the property
            const updated = updatePropertyStatus(
                propertyId,
                result.status as MarketStatus,
                'claude-import'
            );

            if (updated) {
                updates.push({
                    id: propertyId,
                    status: result.status as MarketStatus,
                    details: result.details,
                    matchedBy,
                });
            } else {
                failures.push({
                    index: result.index,
                    address: result.address,
                    reason: `Failed to update property ${propertyId}`,
                });
            }
        }

        return NextResponse.json({
            success: true,
            data: {
                parsed: parseResult.results.length,
                updated: updates.length,
                failed: failures.length,
                summary: parseResult.summary,
                validation: validation.message,
                unparsedLines: parseResult.unparsedLines.length,
                updates,
                failures,
            },
        });

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Error importing status';
        console.error('[Import Status]', message);
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
