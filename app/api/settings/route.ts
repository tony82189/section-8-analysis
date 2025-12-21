import { NextRequest, NextResponse } from 'next/server';
import { getSetting, setSetting, getAllSettings } from '@/lib/db/sqlite';
import { getDefaultSettings, validateSettings, mergeSettings } from '@/lib/filter/engine';
import type { Settings } from '@/lib/types';

export async function GET() {
    try {
        // Get settings from DB, merge with defaults
        const stored = getAllSettings();
        const defaults = getDefaultSettings();

        // Parse stored settings
        const parsed: Partial<Settings> = {};
        for (const [key, value] of Object.entries(stored)) {
            if (key in defaults) {
                const defaultValue = (defaults as Record<string, unknown>)[key];
                if (typeof defaultValue === 'number') {
                    parsed[key as keyof Settings] = parseFloat(value) as never;
                } else if (typeof defaultValue === 'boolean') {
                    parsed[key as keyof Settings] = (value === 'true') as never;
                } else {
                    parsed[key as keyof Settings] = value as never;
                }
            }
        }

        const settings = mergeSettings(parsed);

        return NextResponse.json({
            success: true,
            data: settings,
        });

    } catch (error) {
        console.error('Settings API error:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch settings';
        return NextResponse.json(
            { success: false, error: message },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        // Validate settings
        const validation = validateSettings(body);
        if (!validation.valid) {
            return NextResponse.json(
                { success: false, error: validation.errors.join(', ') },
                { status: 400 }
            );
        }

        // Save each setting
        for (const [key, value] of Object.entries(body)) {
            if (value !== undefined) {
                setSetting(key, String(value));
            }
        }

        // Return merged settings
        const settings = mergeSettings(body);

        return NextResponse.json({
            success: true,
            data: settings,
            message: 'Settings saved successfully',
        });

    } catch (error) {
        console.error('Settings API error:', error);
        const message = error instanceof Error ? error.message : 'Failed to save settings';
        return NextResponse.json(
            { success: false, error: message },
            { status: 500 }
        );
    }
}

export async function PUT(request: NextRequest) {
    // Reset to defaults
    try {
        const defaults = getDefaultSettings();

        for (const [key, value] of Object.entries(defaults)) {
            setSetting(key, String(value));
        }

        return NextResponse.json({
            success: true,
            data: defaults,
            message: 'Settings reset to defaults',
        });

    } catch (error) {
        console.error('Settings API error:', error);
        const message = error instanceof Error ? error.message : 'Failed to reset settings';
        return NextResponse.json(
            { success: false, error: message },
            { status: 500 }
        );
    }
}
