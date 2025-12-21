'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Property } from '@/lib/types';

export default function ManualReviewPage() {
    const params = useParams();
    const runId = params.id as string;

    const [properties, setProperties] = useState<Property[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [filterMode, setFilterMode] = useState<'all' | 'review'>('review');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        fetchProperties();
    }, [runId]);

    const fetchProperties = async () => {
        try {
            const response = await fetch(`/api/properties?runId=${runId}`);
            const result = await response.json();
            if (result.success) {
                setProperties(result.data);
            }
        } catch (error) {
            console.error('Failed to fetch properties:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleUpdate = async (id: string, updates: Partial<Property>) => {
        setSaving(true);
        try {
            const response = await fetch('/api/properties', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, ...updates }),
            });
            const result = await response.json();

            if (result.success) {
                setProperties(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
            }
        } catch (error) {
            console.error('Failed to update property:', error);
        } finally {
            setSaving(false);
        }
    };

    const handleMarkReviewed = async (id: string) => {
        await handleUpdate(id, { needsManualReview: false });
        // Auto-select next property
        const filtered = getFilteredProperties();
        const currentIndex = filtered.findIndex(p => p.id === id);
        if (currentIndex < filtered.length - 1) {
            setSelectedId(filtered[currentIndex + 1].id);
        }
    };

    const getFilteredProperties = () => {
        if (filterMode === 'review') {
            return properties.filter(p => p.needsManualReview);
        }
        return properties;
    };

    const filteredProperties = getFilteredProperties();
    const selectedProperty = properties.find(p => p.id === selectedId);

    // Auto-select first if none selected
    useEffect(() => {
        if (!selectedId && filteredProperties.length > 0) {
            setSelectedId(filteredProperties[0].id);
        }
    }, [filteredProperties.length, selectedId]);

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center">
                    <div className="text-4xl animate-pulse mb-4">📝</div>
                    <p className="text-[var(--muted)]">Loading properties...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-screen flex flex-col">
            {/* Header */}
            <header className="flex items-center justify-between p-4 border-b border-[var(--card-border)] bg-[var(--background)]">
                <div className="flex items-center gap-4">
                    <Link href={`/run/${runId}`} className="text-[var(--muted)] hover:text-[var(--primary)]">
                        ← Back
                    </Link>
                    <h1 className="text-xl font-bold">Manual Review</h1>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setFilterMode('review')}
                            className={`badge cursor-pointer ${filterMode === 'review' ? 'badge-danger' : 'badge-muted'}`}
                        >
                            Needs Review ({properties.filter(p => p.needsManualReview).length})
                        </button>
                        <button
                            onClick={() => setFilterMode('all')}
                            className={`badge cursor-pointer ${filterMode === 'all' ? 'badge-info' : 'badge-muted'}`}
                        >
                            All Properties ({properties.length})
                        </button>
                    </div>
                </div>
            </header>

            <div className="flex-1 flex overflow-hidden">
                {/* Sidebar List */}
                <div className="w-1/3 border-r border-[var(--card-border)] overflow-y-auto bg-[var(--card-bg)]">
                    {filteredProperties.length === 0 ? (
                        <div className="p-8 text-center text-[var(--muted)]">
                            No properties found matching filter
                        </div>
                    ) : (
                        filteredProperties.map(p => (
                            <div
                                key={p.id}
                                onClick={() => setSelectedId(p.id)}
                                className={`p-4 border-b border-[var(--card-border)] cursor-pointer hover:bg-[rgba(102,126,234,0.05)] ${selectedId === p.id ? 'bg-[rgba(102,126,234,0.1)] border-l-4 border-l-[var(--primary)]' : ''
                                    }`}
                            >
                                <div className="flex items-start justify-between mb-1">
                                    <p className="font-medium truncate pr-2">{p.address || 'Unknown Address'}</p>
                                    {p.needsManualReview && <span className="text-xs text-[var(--danger)]">●</span>}
                                </div>
                                <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
                                    <span>${(p.askingPrice || 0).toLocaleString()}</span>
                                    <span>•</span>
                                    <span>Rent: ${(p.rent || 0).toLocaleString()}</span>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Editor Panel */}
                <div className="flex-1 overflow-y-auto p-8 bg-[var(--background)]">
                    {selectedProperty ? (
                        <div className="max-w-3xl mx-auto space-y-8">
                            {/* Review Actions */}
                            <div className="flex items-center justify-between p-4 bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg sticky top-0 z-10">
                                <div>
                                    <h2 className="font-bold text-lg">{selectedProperty.address}</h2>
                                    {selectedProperty.zillowUrl && (
                                        <a
                                            href={selectedProperty.zillowUrl}
                                            target="_blank"
                                            className="text-sm text-[var(--primary)] hover:underline"
                                        >
                                            View on Zillow ↗
                                        </a>
                                    )}
                                </div>
                                <div className="flex gap-3">
                                    <button
                                        onClick={() => handleUpdate(selectedProperty.id, { needsManualReview: true })}
                                        className="btn btn-secondary text-sm"
                                        disabled={selectedProperty.needsManualReview}
                                    >
                                        Flag for Review
                                    </button>
                                    <button
                                        onClick={() => handleMarkReviewed(selectedProperty.id)}
                                        className="btn btn-primary text-sm"
                                    >
                                        {saving ? 'Saving...' : '✅ Approve & Next'}
                                    </button>
                                </div>
                            </div>

                            {/* Raw Text / Context */}
                            <div className="card">
                                <h3 className="text-sm font-bold text-[var(--muted)] uppercase mb-2">Original Text Context</h3>
                                <div className="bg-black/30 p-4 rounded text-sm font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
                                    {selectedProperty.rawText || 'No raw text available'}
                                </div>
                            </div>

                            {/* Fields Editor */}
                            <div className="card grid grid-cols-2 gap-6">
                                <div>
                                    <label className="label">Address</label>
                                    <input
                                        className="input"
                                        value={selectedProperty.address || ''}
                                        onChange={(e) => handleUpdate(selectedProperty.id, { address: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="label">City</label>
                                    <input
                                        className="input"
                                        value={selectedProperty.city || ''}
                                        onChange={(e) => handleUpdate(selectedProperty.id, { city: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="label">State</label>
                                    <input
                                        className="input"
                                        value={selectedProperty.state || ''}
                                        onChange={(e) => handleUpdate(selectedProperty.id, { state: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <label className="label">Zip</label>
                                    <input
                                        className="input"
                                        value={selectedProperty.zip || ''}
                                        onChange={(e) => handleUpdate(selectedProperty.id, { zip: e.target.value })}
                                    />
                                </div>

                                <div className="col-span-2 border-t border-[var(--card-border)] my-2"></div>

                                <div>
                                    <label className="label">Asking Price ($)</label>
                                    <input
                                        type="number"
                                        className="input"
                                        value={selectedProperty.askingPrice || 0}
                                        onChange={(e) => handleUpdate(selectedProperty.id, { askingPrice: parseFloat(e.target.value) })}
                                    />
                                </div>
                                <div>
                                    <label className="label">Estimated Rent ($)</label>
                                    <input
                                        type="number"
                                        className="input"
                                        value={selectedProperty.rent || 0}
                                        onChange={(e) => handleUpdate(selectedProperty.id, { rent: parseFloat(e.target.value) })}
                                    />
                                </div>
                                <div>
                                    <label className="label">Rehab Estimate ($)</label>
                                    <input
                                        type="number"
                                        className="input"
                                        value={selectedProperty.rehabNeeded || 0}
                                        onChange={(e) => handleUpdate(selectedProperty.id, { rehabNeeded: parseFloat(e.target.value) })}
                                    />
                                </div>
                                <div>
                                    <label className="label">ARV ($)</label>
                                    <input
                                        type="number"
                                        className="input"
                                        value={selectedProperty.arv || 0}
                                        onChange={(e) => handleUpdate(selectedProperty.id, { arv: parseFloat(e.target.value) })}
                                    />
                                </div>
                            </div>

                            {/* Status Toggles */}
                            <div className="card space-y-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="font-medium">Section 8 Tenant?</p>
                                        <p className="text-sm text-[var(--muted)]">Is the property currently occupied by Sec 8?</p>
                                    </div>
                                    <button
                                        onClick={() => handleUpdate(selectedProperty.id, { section8Tenant: !selectedProperty.section8Tenant })}
                                        className={`toggle ${selectedProperty.section8Tenant ? 'active' : ''}`}
                                    />
                                </div>
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="font-medium">Occupied?</p>
                                    </div>
                                    <button
                                        onClick={() => handleUpdate(selectedProperty.id, { occupied: !selectedProperty.occupied })}
                                        className={`toggle ${selectedProperty.occupied ? 'active' : ''}`}
                                    />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="h-full flex items-center justify-center text-[var(--muted)]">
                            Select a property to review
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
