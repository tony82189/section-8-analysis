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
    propertiesAnalyzed: number | null;
    topNCount: number | null;
    error: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
}

export default function RunPage() {
    const params = useParams();
    const runId = params.id as string;

    const [run, setRun] = useState<Run | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (runId) {
            fetchRun();
        }
    }, [runId]);

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

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    };

    const getStatusBadge = (status: string) => {
        const statusMap: Record<string, { class: string; label: string; icon: string }> = {
            completed: { class: 'badge-success', label: 'Completed', icon: '✅' },
            processing: { class: 'badge-info', label: 'Processing', icon: '🔄' },
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
                        {run.status === 'completed' && !run.dryRun && (
                            <div className="flex gap-2">
                                <Link
                                    href={`/run/${runId}/review`}
                                    className="btn btn-secondary"
                                >
                                    📝 Manual Review
                                </Link>
                                <a
                                    href={`/data/runs/${run.id}/reports/`}
                                    className="btn btn-primary"
                                    target="_blank"
                                >
                                    📥 Download Report
                                </a>
                            </div>
                        )}
                    </div>
                </header>

                {/* Error Message */}
                {run.error && (
                    <div className="card bg-[var(--danger)]/10 border-[var(--danger)] mb-6">
                        <h3 className="font-bold text-[var(--danger)] mb-2">❌ Error</h3>
                        <p className="text-[var(--danger)]">{run.error}</p>
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
                                {run.propertiesDeduped} properties found. Adjust filters below and start analysis.
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
                                    <label className="label">Min Offer Gap ($)</label>
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
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-8">
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
                            { key: 'analyze', label: 'Underwrite & Forecast', check: run.propertiesAnalyzed !== null },
                            { key: 'rank', label: 'Rank Properties', check: run.topNCount !== null },
                            { key: 'report', label: 'Generate Reports', check: run.status === 'completed' && !run.dryRun },
                        ].map((step, index) => (
                            <div key={step.key} className="flex items-center gap-4">
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
