'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Property } from '@/lib/types';

// Helper to format range values
const formatRange = (min: number | null | undefined, max: number | null | undefined): string => {
    if (min && max && min !== max) {
        return `$${min.toLocaleString()} - $${max.toLocaleString()}`;
    }
    if (max) {
        return `$${max.toLocaleString()}`;
    }
    if (min) {
        return `$${min.toLocaleString()}`;
    }
    return '-';
};

// Helper to format range for sidebar (compact)
const formatRangeCompact = (min: number | null | undefined, max: number | null | undefined): string => {
    if (min && max && min !== max) {
        return `$${min.toLocaleString()}-${max.toLocaleString()}`;
    }
    return `$${(max || min || 0).toLocaleString()}`;
};

export default function ManualReviewPage() {
    const params = useParams();
    const runId = params.id as string;

    const [properties, setProperties] = useState<Property[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [filterMode, setFilterMode] = useState<'all' | 'review' | 'unique' | 'duplicates'>('unique');
    const [saving, setSaving] = useState(false);
    const [imageStatus, setImageStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [statusUpdating, setStatusUpdating] = useState<string | null>(null);

    useEffect(() => {
        fetchProperties();
    }, [runId]);

    // Reset image loading status when selected property changes
    useEffect(() => {
        setImageStatus('loading');
    }, [selectedId]);

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

    const handleCopyAddress = async (property: Property) => {
        const fullAddress = [
            property.address,
            property.city,
            property.state,
            property.zip
        ].filter(Boolean).join(', ');

        try {
            await navigator.clipboard.writeText(fullAddress);
            setCopiedId(property.id);
            setTimeout(() => setCopiedId(null), 2000);
        } catch (err) {
            console.error('Failed to copy address:', err);
        }
    };

    const handleStatusChange = async (id: string, status: string) => {
        setStatusUpdating(id);
        try {
            const response = await fetch(`/api/properties/${id}/status`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, source: 'manual' }),
            });
            const result = await response.json();

            if (result.success) {
                setProperties(prev => prev.map(p =>
                    p.id === id ? {
                        ...p,
                        zillowStatus: status as Property['zillowStatus'],
                        availabilitySource: 'manual' as const,
                        zillowLastChecked: new Date().toISOString()
                    } : p
                ));
            }
        } catch (error) {
            console.error('Failed to update status:', error);
        } finally {
            setStatusUpdating(null);
        }
    };

    const getFilteredProperties = () => {
        switch (filterMode) {
            case 'review':
                return properties.filter(p => p.needsManualReview);
            case 'unique':
                // Only show properties that passed deduplication (status='deduped')
                return properties.filter(p => p.status === 'deduped');
            case 'duplicates':
                return properties.filter(p => p.status === 'discarded');
            default:
                return properties;
        }
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
                            onClick={() => setFilterMode('unique')}
                            className={`badge cursor-pointer ${filterMode === 'unique' ? 'badge-success' : 'badge-muted'}`}
                        >
                            Unique ({properties.filter(p => p.status === 'deduped').length})
                        </button>
                        <button
                            onClick={() => setFilterMode('duplicates')}
                            className={`badge cursor-pointer ${filterMode === 'duplicates' ? 'badge-warning' : 'badge-muted'}`}
                        >
                            Duplicates ({properties.filter(p => p.status === 'discarded').length})
                        </button>
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
                            All ({properties.length})
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
                        filteredProperties.map(p => {
                            const isUnavailable = (p.zillowStatus === 'sold' || p.zillowStatus === 'pending' || (p.zillowStatus === 'off-market' && !p.isOffMarketDeal));
                            const isDuplicate = p.status === 'discarded';
                            return (
                            <div
                                key={p.id}
                                onClick={() => setSelectedId(p.id)}
                                className={`p-4 border-b border-[var(--card-border)] cursor-pointer transition-colors
                                    ${selectedId === p.id ? 'border-l-4 border-l-[var(--primary)]' : ''}
                                    ${isDuplicate
                                        ? 'bg-orange-500/10 hover:bg-orange-500/15'
                                        : isUnavailable
                                        ? 'bg-red-500/10 hover:bg-red-500/15'
                                        : selectedId === p.id
                                            ? 'bg-[rgba(102,126,234,0.1)]'
                                            : 'hover:bg-[rgba(102,126,234,0.05)]'
                                    }
                                `}
                            >
                                <div className="flex items-start justify-between mb-1">
                                    <p className="font-medium truncate pr-2">{p.address || (p.sourcePage ? `Page ${p.sourcePage} - Unknown Address` : 'Unknown Address')}</p>
                                    <div className="flex items-center gap-1 shrink-0">
                                        {isDuplicate && <span className="text-xs px-1.5 py-0.5 bg-orange-500/20 text-orange-400 rounded">DUPE</span>}
                                        {p.zillowStatus === 'sold' && <span className="text-xs px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded">SOLD</span>}
                                        {p.zillowStatus === 'pending' && <span className="text-xs px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 rounded">PENDING</span>}
                                        {p.zillowStatus === 'off-market' && !p.isOffMarketDeal && <span className="text-xs px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded">OFF MKT</span>}
                                        {p.zillowStatus === 'active' && <span className="text-xs px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded">ACTIVE</span>}
                                        {p.isOffMarketDeal && <span className="text-xs px-1.5 py-0.5 bg-orange-500/20 text-orange-400 rounded">DEAL</span>}
                                        {p.needsManualReview && <span className="text-xs text-[var(--danger)]">●</span>}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
                                    <span>${(p.askingPrice || 0).toLocaleString()}</span>
                                    <span>•</span>
                                    <span>Rent: {formatRangeCompact(p.rentMin, p.rentMax || p.rent)}</span>
                                </div>
                            </div>
                            );
                        })
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

                            {/* Duplicate Property Banner */}
                            {selectedProperty.status === 'discarded' && (
                                <div className="p-4 bg-orange-500/10 border border-orange-500/30 rounded-lg">
                                    <h3 className="text-sm font-bold text-orange-400 mb-1">Duplicate Property</h3>
                                    <p className="text-sm text-orange-300">
                                        {selectedProperty.discardReason || 'Matched an existing property from a previous run'}
                                    </p>
                                </div>
                            )}

                            {/* Review Reason Banner */}
                            {selectedProperty.needsManualReview && selectedProperty.reviewNotes && (
                                <div className="p-4 bg-[rgba(239,68,68,0.1)] border border-[var(--danger)] rounded-lg">
                                    <h3 className="text-sm font-bold text-[var(--danger)] mb-2">Flagged for Review</h3>
                                    <p className="text-sm">{selectedProperty.reviewNotes}</p>
                                </div>
                            )}

                            {/* PDF Page Image - Show for ANY flagged property with a source page */}
                            {selectedProperty.needsManualReview && selectedProperty.sourcePage && (
                                <div className="border border-[var(--card-border)] rounded-lg overflow-hidden">
                                    <div className="bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--muted)] border-b border-[var(--card-border)]">
                                        PDF Page {selectedProperty.sourcePage}
                                    </div>
                                    <div className="relative min-h-[200px]">
                                        {/* Loading spinner */}
                                        {imageStatus === 'loading' && (
                                            <div className="absolute inset-0 flex items-center justify-center bg-[var(--card-bg)]">
                                                <div className="flex flex-col items-center gap-2">
                                                    <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full"></div>
                                                    <span className="text-sm text-[var(--muted)]">Loading page image...</span>
                                                </div>
                                            </div>
                                        )}
                                        {/* Error fallback */}
                                        {imageStatus === 'error' && (
                                            <div className="absolute inset-0 flex items-center justify-center bg-[var(--card-bg)]">
                                                <span className="text-sm text-[var(--muted)]">Page image not available</span>
                                            </div>
                                        )}
                                        {/* Image - use key to force remount on src change */}
                                        <img
                                            key={`page-${selectedProperty.sourcePage}`}
                                            src={`/api/runs/${runId}/page-image/${selectedProperty.sourcePage}`}
                                            alt={`PDF Page ${selectedProperty.sourcePage}`}
                                            className={`w-full ${imageStatus !== 'loaded' ? 'opacity-0 absolute' : ''}`}
                                            onLoad={() => setImageStatus('loaded')}
                                            onError={() => setImageStatus('error')}
                                        />
                                    </div>
                                </div>
                            )}

                            {/* Market Status Section */}
                            <div className="card space-y-4">
                                <div className="flex items-center justify-between">
                                    <h3 className="text-sm font-bold text-[var(--muted)] uppercase">Market Status</h3>
                                    <button
                                        onClick={() => handleCopyAddress(selectedProperty)}
                                        className="btn btn-secondary text-xs flex items-center gap-1"
                                    >
                                        {copiedId === selectedProperty.id ? (
                                            <>✅ Copied!</>
                                        ) : (
                                            <>📋 Copy Address</>
                                        )}
                                    </button>
                                </div>

                                <div className="flex items-center gap-4">
                                    <div className="flex-1">
                                        <label className="label text-xs mb-1">Status</label>
                                        <select
                                            value={selectedProperty.zillowStatus || 'unknown'}
                                            onChange={(e) => handleStatusChange(selectedProperty.id, e.target.value)}
                                            disabled={statusUpdating === selectedProperty.id}
                                            className={`input w-full ${
                                                selectedProperty.zillowStatus === 'active' ? 'border-green-500/50 text-green-400' :
                                                selectedProperty.zillowStatus === 'sold' ? 'border-red-500/50 text-red-400' :
                                                selectedProperty.zillowStatus === 'pending' ? 'border-yellow-500/50 text-yellow-400' :
                                                selectedProperty.zillowStatus === 'off-market' ? 'border-orange-500/50 text-orange-400' :
                                                ''
                                            }`}
                                        >
                                            <option value="unknown">Unknown</option>
                                            <option value="active">Active (For Sale)</option>
                                            <option value="pending">Pending</option>
                                            <option value="sold">Sold</option>
                                            <option value="off-market">Off Market</option>
                                        </select>
                                    </div>
                                    <div className="flex-1">
                                        <label className="label text-xs mb-1">Source</label>
                                        <p className="text-sm text-[var(--muted)]">
                                            {selectedProperty.availabilitySource || 'not checked'}
                                        </p>
                                        <p className="text-xs text-[var(--muted)] opacity-50">
                                            {selectedProperty.zillowLastChecked
                                                ? new Date(selectedProperty.zillowLastChecked).toLocaleString()
                                                : 'Never'}
                                        </p>
                                    </div>
                                </div>

                                {/* Status Info Banner */}
                                {selectedProperty.zillowStatus && selectedProperty.zillowStatus !== 'unknown' && (
                                    <div className={`p-3 rounded-lg ${
                                        selectedProperty.zillowStatus === 'active'
                                            ? 'bg-green-500/10 border border-green-500/30'
                                            : (selectedProperty.zillowStatus === 'sold' || selectedProperty.zillowStatus === 'pending' || selectedProperty.zillowStatus === 'off-market')
                                            ? 'bg-red-500/10 border border-red-500/30'
                                            : 'bg-gray-500/10 border border-gray-500/30'
                                    }`}>
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                {selectedProperty.zillowStatus === 'active' && <span className="text-green-400">✅ Available</span>}
                                                {selectedProperty.zillowStatus === 'sold' && <span className="text-red-400">🚫 Sold</span>}
                                                {selectedProperty.zillowStatus === 'pending' && <span className="text-yellow-400">⏳ Under Contract</span>}
                                                {selectedProperty.zillowStatus === 'off-market' && <span className="text-orange-400">📴 Off Market</span>}
                                            </div>
                                            <div className="flex gap-2">
                                                {selectedProperty.isOffMarketDeal && (
                                                    <span className="text-xs px-2 py-1 bg-orange-500/20 text-orange-400 rounded font-medium">Off-Market Deal</span>
                                                )}
                                                {(selectedProperty.zillowStatus === 'sold' ||
                                                  selectedProperty.zillowStatus === 'pending' ||
                                                  selectedProperty.zillowStatus === 'off-market') &&
                                                 !selectedProperty.isOffMarketDeal && (
                                                    <span className="text-xs px-2 py-1 bg-red-500/20 text-red-400 rounded font-medium">EXCLUDED</span>
                                                )}
                                            </div>
                                        </div>
                                        {(selectedProperty.zillowStatus === 'sold' || selectedProperty.zillowStatus === 'pending' || selectedProperty.zillowStatus === 'off-market') &&
                                         !selectedProperty.isOffMarketDeal && (
                                            <p className="text-xs mt-2 text-[var(--muted)]">
                                                This property will be excluded from underwriting analysis
                                            </p>
                                        )}
                                    </div>
                                )}

                                {/* MCP Workflow Hint */}
                                {(!selectedProperty.zillowStatus || selectedProperty.zillowStatus === 'unknown') && (
                                    <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                                        <p className="text-xs text-blue-400">
                                            💡 <strong>Tip:</strong> Click "Copy Address" above, then ask Claude Desktop or Chrome Extension:
                                            "Check Zillow status for [paste address]"
                                        </p>
                                    </div>
                                )}
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
                                    <label className="label">Suggested Offer ($)</label>
                                    <input
                                        type="number"
                                        className="input"
                                        value={selectedProperty.suggestedOffer || 0}
                                        onChange={(e) => handleUpdate(selectedProperty.id, { suggestedOffer: parseFloat(e.target.value) })}
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

                                <div className="col-span-2 border-t border-[var(--card-border)] my-2"></div>

                                {/* Rent Range */}
                                <div className="col-span-2">
                                    <label className="label">Estimated Rent Range ($)</label>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="number"
                                            className="input flex-1"
                                            placeholder="Min"
                                            value={selectedProperty.rentMin || selectedProperty.rent || 0}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                handleUpdate(selectedProperty.id, { rentMin: val, rent: val });
                                            }}
                                        />
                                        <span className="text-[var(--muted)]">-</span>
                                        <input
                                            type="number"
                                            className="input flex-1"
                                            placeholder="Max"
                                            value={selectedProperty.rentMax || selectedProperty.rent || 0}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                handleUpdate(selectedProperty.id, { rentMax: val, rent: val });
                                            }}
                                        />
                                    </div>
                                </div>

                                {/* ARV Range */}
                                <div className="col-span-2">
                                    <label className="label">ARV Range ($)</label>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="number"
                                            className="input flex-1"
                                            placeholder="Min"
                                            value={selectedProperty.arvMin || selectedProperty.arv || 0}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                handleUpdate(selectedProperty.id, { arvMin: val, arv: val });
                                            }}
                                        />
                                        <span className="text-[var(--muted)]">-</span>
                                        <input
                                            type="number"
                                            className="input flex-1"
                                            placeholder="Max"
                                            value={selectedProperty.arvMax || selectedProperty.arv || 0}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                handleUpdate(selectedProperty.id, { arvMax: val, arv: val });
                                            }}
                                        />
                                    </div>
                                </div>

                                <div className="col-span-2 border-t border-[var(--card-border)] my-2"></div>

                                <div>
                                    <label className="label">Bedrooms</label>
                                    <input
                                        type="number"
                                        className="input"
                                        value={selectedProperty.bedrooms || 0}
                                        onChange={(e) => handleUpdate(selectedProperty.id, { bedrooms: parseInt(e.target.value) })}
                                    />
                                </div>
                                <div>
                                    <label className="label">Bathrooms</label>
                                    <input
                                        type="number"
                                        step="0.5"
                                        className="input"
                                        value={selectedProperty.bathrooms || 0}
                                        onChange={(e) => handleUpdate(selectedProperty.id, { bathrooms: parseFloat(e.target.value) })}
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
