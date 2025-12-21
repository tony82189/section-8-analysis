'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Settings {
    minRent: number;
    minBedrooms: number;
    minBathrooms: number;
    occupiedSec8Only: boolean;
    offerGapThreshold: number;
    vacancyEnabled: boolean;
    vacancyPercent: number;
    maintenanceEnabled: boolean;
    maintenancePercent: number;
    downPaymentPercent: number;
    closingCostPercent: number;
    dscrRate: number;
    loanTermYears: number;
    pmFeePercent: number;
    propertyTaxRate: number;
    insuranceAnnual: number;
    rentGrowthPercent: number;
    appreciationPercent: number;
    expenseInflationPercent: number;
    topN: number;
    sheetsEnabled: boolean;
    spreadsheetId?: string;
}

export default function SettingsPage() {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            const response = await fetch('/api/settings');
            const result = await response.json();
            if (result.success) {
                setSettings(result.data);
            }
        } catch (error) {
            console.error('Failed to fetch settings:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        if (!settings) return;

        setSaving(true);
        setMessage(null);

        try {
            const response = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings),
            });

            const result = await response.json();

            if (result.success) {
                setMessage({ type: 'success', text: 'Settings saved successfully!' });
            } else {
                setMessage({ type: 'error', text: result.error || 'Failed to save settings' });
            }
        } catch (error) {
            setMessage({ type: 'error', text: 'Failed to save settings' });
        } finally {
            setSaving(false);
        }
    };

    const handleReset = async () => {
        if (!confirm('Reset all settings to defaults?')) return;

        setSaving(true);
        try {
            const response = await fetch('/api/settings', { method: 'PUT' });
            const result = await response.json();
            if (result.success) {
                setSettings(result.data);
                setMessage({ type: 'success', text: 'Settings reset to defaults!' });
            }
        } catch (error) {
            setMessage({ type: 'error', text: 'Failed to reset settings' });
        } finally {
            setSaving(false);
        }
    };

    const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
        if (settings) {
            setSettings({ ...settings, [key]: value });
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center">
                    <div className="text-4xl animate-pulse mb-4">⚙️</div>
                    <p className="text-[var(--muted)]">Loading settings...</p>
                </div>
            </div>
        );
    }

    if (!settings) return null;

    return (
        <div className="min-h-screen p-8">
            <div className="max-w-4xl mx-auto">
                {/* Header */}
                <header className="flex items-center justify-between mb-8">
                    <div>
                        <Link href="/" className="text-[var(--muted)] hover:text-[var(--primary)] mb-2 inline-block">
                            ← Back to Dashboard
                        </Link>
                        <h1 className="text-3xl font-bold">⚙️ Settings</h1>
                    </div>
                    <div className="flex gap-4">
                        <button onClick={handleReset} className="btn btn-secondary" disabled={saving}>
                            Reset Defaults
                        </button>
                        <button onClick={handleSave} className="btn btn-primary" disabled={saving}>
                            {saving ? 'Saving...' : 'Save Settings'}
                        </button>
                    </div>
                </header>

                {/* Message */}
                {message && (
                    <div className={`mb-6 p-4 rounded-lg ${message.type === 'success'
                            ? 'bg-[var(--success)]/15 text-[var(--success)]'
                            : 'bg-[var(--danger)]/15 text-[var(--danger)]'
                        }`}>
                        {message.text}
                    </div>
                )}

                {/* Filter Criteria */}
                <section className="card mb-6">
                    <h2 className="text-xl font-bold mb-6">📋 Filter Criteria</h2>
                    <div className="grid md:grid-cols-2 gap-6">
                        <div>
                            <label className="label">Minimum Rent ($)</label>
                            <input
                                type="number"
                                className="input"
                                value={settings.minRent}
                                onChange={(e) => updateSetting('minRent', parseInt(e.target.value) || 0)}
                            />
                        </div>
                        <div>
                            <label className="label">Maximum Offer Gap ($)</label>
                            <input
                                type="number"
                                className="input"
                                value={settings.offerGapThreshold}
                                onChange={(e) => updateSetting('offerGapThreshold', parseInt(e.target.value) || 0)}
                            />
                            <p className="text-xs text-[var(--muted)] mt-1">
                                Discard if asking - suggested offer exceeds this
                            </p>
                        </div>
                        <div>
                            <label className="label">Minimum Bedrooms</label>
                            <input
                                type="number"
                                className="input"
                                value={settings.minBedrooms}
                                onChange={(e) => updateSetting('minBedrooms', parseInt(e.target.value) || 0)}
                            />
                        </div>
                        <div>
                            <label className="label">Minimum Bathrooms</label>
                            <input
                                type="number"
                                step="0.5"
                                className="input"
                                value={settings.minBathrooms}
                                onChange={(e) => updateSetting('minBathrooms', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="md:col-span-2 flex items-center justify-between p-4 bg-[var(--background)] rounded-lg">
                            <div>
                                <p className="font-medium">Occupied Section 8 Only</p>
                                <p className="text-sm text-[var(--muted)]">
                                    Only include properties with current Section 8 tenant
                                </p>
                            </div>
                            <button
                                onClick={() => updateSetting('occupiedSec8Only', !settings.occupiedSec8Only)}
                                className={`toggle ${settings.occupiedSec8Only ? 'active' : ''}`}
                            />
                        </div>
                    </div>
                </section>

                {/* Underwriting Assumptions */}
                <section className="card mb-6">
                    <h2 className="text-xl font-bold mb-6">💰 Underwriting Assumptions</h2>
                    <div className="grid md:grid-cols-2 gap-6">
                        <div>
                            <label className="label">Down Payment (%)</label>
                            <input
                                type="number"
                                className="input"
                                value={settings.downPaymentPercent}
                                onChange={(e) => updateSetting('downPaymentPercent', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div>
                            <label className="label">Closing Costs (%)</label>
                            <input
                                type="number"
                                className="input"
                                value={settings.closingCostPercent}
                                onChange={(e) => updateSetting('closingCostPercent', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div>
                            <label className="label">DSCR Loan Rate (%)</label>
                            <input
                                type="number"
                                step="0.1"
                                min="7"
                                max="8.5"
                                className="input"
                                value={settings.dscrRate}
                                onChange={(e) => updateSetting('dscrRate', parseFloat(e.target.value) || 8)}
                            />
                            <p className="text-xs text-[var(--muted)] mt-1">Range: 7.0% - 8.5%</p>
                        </div>
                        <div>
                            <label className="label">Loan Term (years)</label>
                            <input
                                type="number"
                                className="input"
                                value={settings.loanTermYears}
                                onChange={(e) => updateSetting('loanTermYears', parseInt(e.target.value) || 30)}
                            />
                        </div>
                        <div>
                            <label className="label">Property Management (%)</label>
                            <input
                                type="number"
                                className="input"
                                value={settings.pmFeePercent}
                                onChange={(e) => updateSetting('pmFeePercent', parseFloat(e.target.value) || 0)}
                            />
                            <p className="text-xs text-[var(--muted)] mt-1">Always on</p>
                        </div>
                        <div>
                            <label className="label">Property Tax Rate (%)</label>
                            <input
                                type="number"
                                step="0.1"
                                className="input"
                                value={settings.propertyTaxRate}
                                onChange={(e) => updateSetting('propertyTaxRate', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div>
                            <label className="label">Annual Insurance ($)</label>
                            <input
                                type="number"
                                className="input"
                                value={settings.insuranceAnnual}
                                onChange={(e) => updateSetting('insuranceAnnual', parseInt(e.target.value) || 0)}
                            />
                        </div>
                        <div>
                            <label className="label">Top N Deals</label>
                            <input
                                type="number"
                                className="input"
                                value={settings.topN}
                                onChange={(e) => updateSetting('topN', parseInt(e.target.value) || 10)}
                            />
                        </div>

                        {/* Vacancy Toggle */}
                        <div className="md:col-span-2 flex items-center justify-between p-4 bg-[var(--background)] rounded-lg">
                            <div className="flex-1">
                                <p className="font-medium">Vacancy Allowance</p>
                                <p className="text-sm text-[var(--muted)]">
                                    Include vacancy expense in calculations
                                </p>
                            </div>
                            {settings.vacancyEnabled && (
                                <input
                                    type="number"
                                    className="input w-24 mr-4"
                                    value={settings.vacancyPercent}
                                    onChange={(e) => updateSetting('vacancyPercent', parseFloat(e.target.value) || 0)}
                                />
                            )}
                            <button
                                onClick={() => updateSetting('vacancyEnabled', !settings.vacancyEnabled)}
                                className={`toggle ${settings.vacancyEnabled ? 'active' : ''}`}
                            />
                        </div>

                        {/* Maintenance Toggle */}
                        <div className="md:col-span-2 flex items-center justify-between p-4 bg-[var(--background)] rounded-lg">
                            <div className="flex-1">
                                <p className="font-medium">Maintenance Reserve</p>
                                <p className="text-sm text-[var(--muted)]">
                                    Include maintenance expense in calculations
                                </p>
                            </div>
                            {settings.maintenanceEnabled && (
                                <input
                                    type="number"
                                    className="input w-24 mr-4"
                                    value={settings.maintenancePercent}
                                    onChange={(e) => updateSetting('maintenancePercent', parseFloat(e.target.value) || 0)}
                                />
                            )}
                            <button
                                onClick={() => updateSetting('maintenanceEnabled', !settings.maintenanceEnabled)}
                                className={`toggle ${settings.maintenanceEnabled ? 'active' : ''}`}
                            />
                        </div>
                    </div>
                </section>

                {/* Forecast Assumptions */}
                <section className="card mb-6">
                    <h2 className="text-xl font-bold mb-6">📈 Forecast Assumptions</h2>
                    <div className="grid md:grid-cols-3 gap-6">
                        <div>
                            <label className="label">Rent Growth (%/year)</label>
                            <input
                                type="number"
                                step="0.5"
                                className="input"
                                value={settings.rentGrowthPercent}
                                onChange={(e) => updateSetting('rentGrowthPercent', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div>
                            <label className="label">Appreciation (%/year)</label>
                            <input
                                type="number"
                                step="0.5"
                                className="input"
                                value={settings.appreciationPercent}
                                onChange={(e) => updateSetting('appreciationPercent', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div>
                            <label className="label">Expense Inflation (%/year)</label>
                            <input
                                type="number"
                                step="0.5"
                                className="input"
                                value={settings.expenseInflationPercent}
                                onChange={(e) => updateSetting('expenseInflationPercent', parseFloat(e.target.value) || 0)}
                            />
                        </div>
                    </div>
                </section>

                {/* Google Sheets */}
                <section className="card">
                    <h2 className="text-xl font-bold mb-6">🔗 Google Sheets Integration</h2>
                    <div className="space-y-6">
                        <div className="flex items-center justify-between p-4 bg-[var(--background)] rounded-lg">
                            <div>
                                <p className="font-medium">Enable Google Sheets</p>
                                <p className="text-sm text-[var(--muted)]">
                                    Sync data to Google Sheets for collaboration
                                </p>
                            </div>
                            <button
                                onClick={() => updateSetting('sheetsEnabled', !settings.sheetsEnabled)}
                                className={`toggle ${settings.sheetsEnabled ? 'active' : ''}`}
                            />
                        </div>
                        {settings.sheetsEnabled && (
                            <div>
                                <label className="label">Spreadsheet ID</label>
                                <input
                                    type="text"
                                    className="input"
                                    placeholder="1BxiMKd3..."
                                    value={settings.spreadsheetId || ''}
                                    onChange={(e) => updateSetting('spreadsheetId', e.target.value)}
                                />
                                <p className="text-xs text-[var(--muted)] mt-1">
                                    Find this in your Google Sheets URL
                                </p>
                            </div>
                        )}
                    </div>
                </section>
            </div>
        </div>
    );
}
