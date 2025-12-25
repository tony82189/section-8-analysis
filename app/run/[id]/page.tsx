'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

interface Run {
    id: string;
    fileName: string;
    fileSize: number;
    status: string;
    dryRun: boolean;
    totalPages: number | null;
    chunksCreated: number | null;
    propertiesExtracted: number | null;
    propertiesFiltered: number | null;
    propertiesDeduped: number | null;
    propertiesUnavailable: number | null;
    propertiesAnalyzed: number | null;
    topNCount: number | null;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    progress: number | null;
    currentStep: string | null;
}

export default function RunPage() {
    const params = useParams();
    const runId = params.id as string;

    const [run, setRun] = useState<Run | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Step 5: Availability check states
    const [properties, setProperties] = useState<any[]>([]);
    const [promptCopied, setPromptCopied] = useState(false);
    const [claudeResponse, setClaudeResponse] = useState('');
    const [importResult, setImportResult] = useState<any>(null);
    const [importing, setImporting] = useState(false);

    useEffect(() => {
        if (runId) {
            fetchRun();
        }
    }, [runId]);

    // Fetch properties when run is in waiting-for-review status
    useEffect(() => {
        if (run?.status === 'waiting-for-review' && runId) {
            fetchProperties();
        }
    }, [run?.status, runId]);

    const fetchProperties = async () => {
        try {
            const response = await fetch(`/api/properties?runId=${runId}`);
            const result = await response.json();
            if (result.success) {
                setProperties(result.data);
            }
        } catch (err) {
            console.error('Failed to fetch properties:', err);
        }
    };

    // Auto-refresh when processing
    useEffect(() => {
        if (!run) return;
        const processingStatuses = ['checking-availability', 'splitting', 'extracting', 'parsing', 'filtering', 'deduping', 'underwriting', 'forecasting', 'ranking', 'generating-reports'];
        if (processingStatuses.includes(run.status)) {
            const interval = setInterval(fetchRun, 2000); // Poll every 2 seconds
            return () => clearInterval(interval);
        }
    }, [run?.status]);

    const fetchRun = async () => {
        try {
            const response = await fetch(`/api/runs?id=${runId}`);
            const result = await response.json();

            if (result.success) {
                setRun(result.data);
            } else {
                setError(result.error || 'Run not found');
            }
        } catch (err) {
            setError('Failed to load run');
        } finally {
            setLoading(false);
        }
    };

    const formatDate = (dateString: string | null) => {
        if (!dateString) return 'N/A';
        return new Date(dateString).toLocaleString();
    };

    const handleAnalyze = async (settings: any) => {
        setLoading(true);
        try {
            const response = await fetch(`/api/runs/${runId}/analyze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings }),
            });
            const result = await response.json();
            if (result.success) {
                setRun(result.data);
            } else {
                setError(result.error);
            }
        } catch (err) {
            setError('Analysis failed');
        } finally {
            setLoading(false);
        }
    };

    const handleClearProperties = async () => {
        if (!confirm('Clear all extracted properties? You will need to re-upload the PDF to extract again.')) {
            return;
        }

        setLoading(true);
        try {
            const response = await fetch('/api/runs', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: runId, action: 'clear-properties' }),
            });
            const result = await response.json();

            if (result.success) {
                alert(`Cleared ${result.deletedCount} properties. Run reset to pending.`);
                fetchRun(); // Refresh run data
            } else {
                alert('Failed to clear properties: ' + result.error);
            }
        } catch (err) {
            alert('Failed to clear properties');
        } finally {
            setLoading(false);
        }
    };

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    };

    // Get properties needing availability check
    const propertiesNeedingCheck = properties.filter(p =>
        p.status === 'deduped' &&
        (!p.zillowStatus || p.zillowStatus === 'unknown' || p.zillowStatus === 'needs-review')
    );

    // Generate and copy Claude prompt
    const handleCopyPrompt = async () => {
        const validProperties = propertiesNeedingCheck.filter((p: any) => p.address && p.city && p.state);

        if (validProperties.length === 0) {
            alert('No properties with complete addresses to check.');
            return;
        }

        const addresses = validProperties
            .map((p: any, i: number) => `${i + 1}. ${p.address}, ${p.city}, ${p.state}${p.zip ? ' ' + p.zip : ''}`)
            .join('\n');

        const prompt = `Check the availability status of these ${validProperties.length} properties on Zillow.
For each property, search on Zillow and report the current status.

Properties to check:
${addresses}

Return your results in this EXACT format (one per line):
[NUMBER]. [ADDRESS] | [STATUS] | [DETAILS]

Where STATUS must be one of: ACTIVE, PENDING, SOLD, OFF-MARKET, NOT-FOUND

Example format:
1. 123 Main St, Memphis, TN 38116 | SOLD | Sold Dec 15, 2024 for $125,000
2. 456 Oak Ave, Memphis, TN 38118 | ACTIVE | Listed at $89,900

Begin checking each property now and report the results.`;

        try {
            await navigator.clipboard.writeText(prompt);
            setPromptCopied(true);
            setTimeout(() => setPromptCopied(false), 3000);
        } catch (err) {
            console.error('Failed to copy:', err);
            alert('Failed to copy to clipboard');
        }
    };

    // Import Claude's response
    const handleImportResults = async () => {
        if (!claudeResponse.trim()) {
            alert('Please paste Claude\'s response first.');
            return;
        }

        setImporting(true);
        setImportResult(null);

        try {
            const response = await fetch('/api/properties/import-status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ runId, response: claudeResponse }),
            });

            const result = await response.json();

            if (result.success) {
                setImportResult(result.data);
                // Refresh properties to show updated statuses
                fetchProperties();
                fetchRun();
            } else {
                setImportResult({ error: result.error });
            }
        } catch (err) {
            setImportResult({ error: 'Failed to import results' });
        } finally {
            setImporting(false);
        }
    };

    const getStatusBadge = (status: string) => {
        const statusMap: Record<string, { class: string; label: string; icon: string }> = {
            completed: { class: 'badge-success', label: 'Completed', icon: '✅' },
            processing: { class: 'badge-info', label: 'Processing', icon: '🔄' },
            'checking-availability': { class: 'badge-info', label: 'Checking Availability', icon: '🔍' },
            failed: { class: 'badge-danger', label: 'Failed', icon: '❌' },
            pending: { class: 'badge-muted', label: 'Pending', icon: '⏳' },
            'waiting-for-review': { class: 'badge-warning', label: 'Review Needed', icon: '👀' },
        };

        const config = statusMap[status] || { class: 'badge-muted', label: status, icon: '❓' };
        return <span className={`badge ${config.class}`}>{config.icon} {config.label}</span>;
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center">
                    <div className="text-4xl animate-pulse mb-4">⏳</div>
                    <p className="text-[var(--muted)]">Loading run...</p>
                </div>
            </div>
        );
    }

    if (error || !run) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-center">
                    <div className="text-4xl mb-4">😕</div>
                    <h2 className="text-xl font-bold mb-2">Run Not Found</h2>
                    <p className="text-[var(--muted)] mb-6">{error}</p>
                    <Link href="/" className="btn btn-primary">
                        ← Back to Dashboard
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen p-8">
            <div className="max-w-6xl mx-auto">
                {/* Header */}
                <header className="mb-8">
                    <Link href="/" className="text-[var(--muted)] hover:text-[var(--primary)] mb-4 inline-block">
                        ← Back to Dashboard
                    </Link>
                    <div className="flex items-start justify-between">
                        <div>
                            <h1 className="text-3xl font-bold flex items-center gap-3">
                                📄 {run.fileName}
                            </h1>
                            <div className="flex items-center gap-4 mt-2">
                                {getStatusBadge(run.status)}
                                {run.dryRun && <span className="badge badge-warning">Dry Run</span>}
                                <span className="text-[var(--muted)] text-sm">
                                    {formatFileSize(run.fileSize)}
                                </span>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            {(run.propertiesExtracted ?? 0) > 0 && (
                                <>
                                    <Link
                                        href={`/run/${runId}/review`}
                                        className="btn btn-secondary"
                                    >
                                        📋 View Properties
                                    </Link>
                                    <button
                                        onClick={handleClearProperties}
                                        disabled={loading}
                                        className="btn bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 border border-orange-500/30"
                                    >
                                        🗑️ Clear Properties
                                    </button>
                                </>
                            )}
                            {run.status === 'completed' && !run.dryRun && (
                                <a
                                    href={`/data/runs/${run.id}/reports/`}
                                    className="btn btn-primary"
                                    target="_blank"
                                >
                                    📥 Download Report
                                </a>
                            )}
                        </div>
                    </div>
                </header>

                {/* Error Message */}
                {run.error && (
                    <div className="card bg-[var(--danger)]/10 border-[var(--danger)] mb-6">
                        <h3 className="font-bold text-[var(--danger)] mb-2">❌ Error</h3>
                        <p className="text-[var(--danger)]">{run.error}</p>
                    </div>
                )}

                {/* Pipeline Summary - show when extraction complete */}
                {run.propertiesExtracted !== null && run.propertiesFiltered !== null && run.propertiesDeduped !== null && (
                    <div className="card border-blue-500/30 mb-6 bg-blue-500/5">
                        <h3 className="font-bold text-blue-400 mb-3">Pipeline Summary</h3>
                        <div className="grid grid-cols-4 gap-4 text-sm">
                            <div>
                                <p className="text-[var(--muted)]">Extracted</p>
                                <p className="text-xl font-bold">{run.propertiesExtracted}</p>
                            </div>
                            <div>
                                <p className="text-[var(--muted)]">Passed Filter</p>
                                <p className="text-xl font-bold">{run.propertiesFiltered}</p>
                                {run.propertiesExtracted > run.propertiesFiltered && (
                                    <p className="text-xs text-[var(--muted)]">
                                        ({run.propertiesExtracted - run.propertiesFiltered} filtered out)
                                    </p>
                                )}
                            </div>
                            <div>
                                <p className="text-[var(--muted)]">Unique</p>
                                <p className="text-xl font-bold text-green-400">{run.propertiesDeduped}</p>
                            </div>
                            <div>
                                <p className="text-[var(--muted)]">Duplicates</p>
                                <p className="text-xl font-bold text-orange-400">
                                    {(run.propertiesFiltered || 0) - (run.propertiesDeduped || 0)}
                                </p>
                            </div>
                        </div>
                        {(run.propertiesFiltered || 0) > (run.propertiesDeduped || 0) && (
                            <p className="text-xs text-[var(--muted)] mt-3">
                                Duplicates found within this PDF or matched entries from previous runs.
                            </p>
                        )}
                    </div>
                )}

                {/* Market Status Check Progress */}
                {run.status === 'checking-availability' && (
                    <div className="card border-blue-500/30 mb-6 bg-blue-500/5">
                        <div className="flex items-center gap-3 mb-3">
                            <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full"></div>
                            <h3 className="font-bold text-blue-400">Checking Market Availability...</h3>
                        </div>
                        <div className="w-full bg-gray-700 rounded-full h-2.5 mb-2">
                            <div
                                className="bg-blue-500 h-2.5 rounded-full transition-all duration-300"
                                style={{ width: `${run.progress || 0}%` }}
                            ></div>
                        </div>
                        <p className="text-sm text-[var(--muted)]">
                            {run.currentStep || 'Checking property availability...'}
                        </p>
                    </div>
                )}

                {/* Intermission: Filter & Analyze */}
                {run.status === 'waiting-for-review' && (
                    <div className="card border-primary mb-8 bg-blue-500/5">
                        <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
                            <span>🔍</span> Review & Analyze
                        </h2>
                        <div className="flex flex-col gap-4">
                            <p className="text-[var(--muted)]">
                                {run.propertiesDeduped} properties found{run.propertiesUnavailable ? ` (${run.propertiesUnavailable} not available - sold/pending)` : ''}. Adjust filters below and start analysis.
                            </p>

                            {/* Simple Quick Filters for MVP */}
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    const fd = new FormData(e.currentTarget);
                                    handleAnalyze({
                                        minRent: Number(fd.get('minRent')),
                                        offerGapThreshold: Number(fd.get('offerGap')),
                                    });
                                }}
                                className="grid md:grid-cols-3 gap-4 items-end"
                            >
                                <div>
                                    <label className="label">Min Rent ($)</label>
                                    <input name="minRent" type="number" defaultValue={1300} className="input bg-[var(--background)]" />
                                </div>
                                <div>
                                    <label className="label">Max Offer Gap ($)</label>
                                    <input name="offerGap" type="number" defaultValue={10000} className="input bg-[var(--background)]" />
                                </div>
                                <button type="submit" disabled={loading} className="btn btn-primary h-10 self-end">
                                    {loading ? 'Starting...' : '🚀 Start Analysis'}
                                </button>
                            </form>
                        </div>
                    </div>
                )}

                {/* Stats Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4 mb-8">
                    <div className="stat-card">
                        <div className="stat-value">{run.totalPages ?? '-'}</div>
                        <div className="stat-label">Pages</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-value">{run.chunksCreated ?? '-'}</div>
                        <div className="stat-label">Chunks</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-value">{run.propertiesExtracted ?? '-'}</div>
                        <div className="stat-label">Extracted</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-value">{run.propertiesFiltered ?? '-'}</div>
                        <div className="stat-label">Filtered</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-value">{run.propertiesDeduped ?? '-'}</div>
                        <div className="stat-label">Unique</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-value text-red-400">{run.propertiesUnavailable ?? '-'}</div>
                        <div className="stat-label">Not Available</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-value">{run.propertiesAnalyzed ?? '-'}</div>
                        <div className="stat-label">Analyzed</div>
                    </div>
                    <div className="stat-card">
                        <div className="stat-value text-[var(--success)]">{run.topNCount ?? '-'}</div>
                        <div className="stat-label">Top Deals</div>
                    </div>
                </div>

                {/* Pipeline Progress */}
                <div className="card mb-8">
                    <h2 className="text-xl font-bold mb-6">🔄 Pipeline Progress</h2>
                    <div className="space-y-4">
                        {[
                            { key: 'split', label: 'Split PDF', check: run.chunksCreated !== null },
                            { key: 'extract', label: 'Extract/OCR', check: run.propertiesExtracted !== null },
                            { key: 'filter', label: 'Apply Filters', check: run.propertiesFiltered !== null },
                            { key: 'dedup', label: 'Deduplicate', check: run.propertiesDeduped !== null },
                            { key: 'availability', label: 'Check Availability', check: run.propertiesUnavailable !== null, isStep5: true },
                            { key: 'analyze', label: 'Underwrite & Forecast', check: run.propertiesAnalyzed !== null },
                            { key: 'rank', label: 'Rank Properties', check: run.topNCount !== null },
                            { key: 'report', label: 'Generate Reports', check: run.status === 'completed' && !run.dryRun },
                        ].map((step, index) => (
                            <div key={step.key}>
                                <div className="flex items-center gap-4">
                                    <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold ${step.check
                                        ? 'bg-[var(--success)] text-white'
                                        : run.status === 'failed'
                                            ? 'bg-[var(--danger)]/20 text-[var(--danger)]'
                                            : 'bg-[var(--card-border)] text-[var(--muted)]'
                                        }`}>
                                        {step.check ? '✓' : index + 1}
                                    </div>
                                    <div className="flex-1">
                                        <span className={step.check ? 'font-medium' : 'text-[var(--muted)]'}>
                                            {step.label}
                                        </span>
                                    </div>
                                    {step.check && (
                                        <span className="badge badge-success">Complete</span>
                                    )}
                                    {(step as any).isStep5 && run.status === 'waiting-for-review' && !step.check && (
                                        <span className="badge badge-warning">Action Required</span>
                                    )}
                                </div>

                                {/* Step 5: Interactive Availability Check Panel */}
                                {(step as any).isStep5 && run.status === 'waiting-for-review' && !step.check && (
                                    <div className="ml-14 mt-4 p-4 bg-blue-500/5 border border-blue-500/30 rounded-lg">
                                        <h3 className="font-bold text-blue-400 mb-3">
                                            📋 Check Property Availability via Claude
                                        </h3>
                                        <p className="text-sm text-[var(--muted)] mb-4">
                                            {propertiesNeedingCheck.length} properties need status check.
                                            Use Claude Chrome Extension to check Zillow status.
                                        </p>

                                        {/* Step 1: Copy Prompt */}
                                        <div className="mb-4">
                                            <p className="text-xs text-[var(--muted)] mb-2">
                                                <strong>Step 1:</strong> Copy the prompt and paste it in Claude Chrome Extension
                                            </p>
                                            <button
                                                onClick={handleCopyPrompt}
                                                disabled={propertiesNeedingCheck.length === 0}
                                                className="btn btn-secondary"
                                            >
                                                {promptCopied ? '✅ Copied!' : '📋 Copy Prompt to Clipboard'}
                                            </button>
                                        </div>

                                        {/* Step 2: Instructions */}
                                        <div className="mb-4 p-3 bg-black/20 rounded text-xs text-[var(--muted)]">
                                            <strong>Step 2:</strong> Open Claude Chrome Extension, paste the prompt, and let Claude check each property on Zillow.
                                        </div>

                                        {/* Step 3: Paste Response */}
                                        <div className="mb-4">
                                            <p className="text-xs text-[var(--muted)] mb-2">
                                                <strong>Step 3:</strong> Paste Claude's response below
                                            </p>
                                            <textarea
                                                value={claudeResponse}
                                                onChange={(e) => setClaudeResponse(e.target.value)}
                                                placeholder="Paste Claude's response here...

Example format:
1. 123 Main St, Memphis, TN 38116 | SOLD | Sold Dec 2024
2. 456 Oak Ave, Memphis, TN 38118 | ACTIVE | Listed at $89,900"
                                                className="input w-full h-32 font-mono text-sm"
                                            />
                                        </div>

                                        {/* Import Button */}
                                        <div className="flex gap-3">
                                            <button
                                                onClick={handleImportResults}
                                                disabled={importing || !claudeResponse.trim()}
                                                className="btn btn-primary"
                                            >
                                                {importing ? '⏳ Importing...' : '📥 Import Results & Continue'}
                                            </button>
                                            <button
                                                onClick={() => {
                                                    if (confirm('Skip availability check? Properties will have "Unknown" status.')) {
                                                        // Just proceed - the analyze step handles unknown statuses
                                                        setClaudeResponse('');
                                                        setImportResult(null);
                                                    }
                                                }}
                                                className="btn btn-secondary"
                                            >
                                                Skip Step 5
                                            </button>
                                        </div>

                                        {/* Import Result */}
                                        {importResult && (
                                            <div className={`mt-4 p-3 rounded ${importResult.error ? 'bg-red-500/10 border border-red-500/30' : 'bg-green-500/10 border border-green-500/30'}`}>
                                                {importResult.error ? (
                                                    <p className="text-red-400 text-sm">{importResult.error}</p>
                                                ) : (
                                                    <div className="text-sm">
                                                        <p className="text-green-400 font-medium mb-2">
                                                            ✅ {importResult.validation}
                                                        </p>
                                                        <div className="grid grid-cols-5 gap-2 text-xs">
                                                            <div className="text-center">
                                                                <p className="text-green-400 font-bold">{importResult.summary?.active || 0}</p>
                                                                <p className="text-[var(--muted)]">Active</p>
                                                            </div>
                                                            <div className="text-center">
                                                                <p className="text-yellow-400 font-bold">{importResult.summary?.pending || 0}</p>
                                                                <p className="text-[var(--muted)]">Pending</p>
                                                            </div>
                                                            <div className="text-center">
                                                                <p className="text-red-400 font-bold">{importResult.summary?.sold || 0}</p>
                                                                <p className="text-[var(--muted)]">Sold</p>
                                                            </div>
                                                            <div className="text-center">
                                                                <p className="text-orange-400 font-bold">{importResult.summary?.offMarket || 0}</p>
                                                                <p className="text-[var(--muted)]">Off-Market</p>
                                                            </div>
                                                            <div className="text-center">
                                                                <p className="text-gray-400 font-bold">{importResult.summary?.notFound || 0}</p>
                                                                <p className="text-[var(--muted)]">Not Found</p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Timestamps */}
                <div className="card">
                    <h2 className="text-xl font-bold mb-4">📅 Timeline</h2>
                    <div className="grid md:grid-cols-3 gap-6">
                        <div>
                            <p className="text-sm text-[var(--muted)] mb-1">Created</p>
                            <p className="font-medium">{formatDate(run.createdAt)}</p>
                        </div>
                        <div>
                            <p className="text-sm text-[var(--muted)] mb-1">Started</p>
                            <p className="font-medium">{formatDate(run.startedAt)}</p>
                        </div>
                        <div>
                            <p className="text-sm text-[var(--muted)] mb-1">Completed</p>
                            <p className="font-medium">{formatDate(run.completedAt)}</p>
                        </div>
                    </div>
                    {run.startedAt && run.completedAt && (
                        <div className="mt-4 pt-4 border-t border-[var(--card-border)]">
                            <p className="text-sm text-[var(--muted)]">
                                Duration: {Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)} seconds
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
