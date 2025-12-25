'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import UploadWizard from '@/components/upload/wizard';

interface Run {
  id: string;
  fileName: string;
  status: string;
  currentStep: string | null;
  progress: number;
  propertiesExtracted: number | null;
  propertiesFiltered: number | null;
  propertiesDeduped: number | null;
  propertiesUnavailable: number | null;
  topNCount: number | null;
  createdAt: string;
  completedAt: string | null;
}

// Statuses that indicate active processing
const ACTIVE_STATUSES = [
  'pending', 'splitting', 'extracting', 'parsing',
  'filtering', 'deduping', 'checking-availability',
  'checking-zillow', 'underwriting',
  'forecasting', 'ranking', 'generating-reports'
];

function isActiveRun(status: string): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export default function Dashboard() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);

  useEffect(() => {
    fetchRuns();
  }, []);

  // Auto-refresh when there are active runs
  useEffect(() => {
    const hasActiveRuns = runs.some(run => isActiveRun(run.status));

    if (!hasActiveRuns) return;

    const interval = setInterval(() => {
      fetchRuns();
    }, 2000); // Poll every 2 seconds

    return () => clearInterval(interval);
  }, [runs]);

  const fetchRuns = async () => {
    try {
      const response = await fetch('/api/runs');
      const result = await response.json();
      if (result.success) {
        setRuns(result.data.runs);
      }
    } catch (error) {
      console.error('Failed to fetch runs:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleUploadComplete = () => {
    setShowUpload(false);
    fetchRuns();
  };

  const handleDeleteRun = async (id: string, fileName: string) => {
    if (!confirm(`Delete run "${fileName}"? This cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(`/api/runs?id=${id}`, { method: 'DELETE' });
      const result = await response.json();
      if (result.success) {
        fetchRuns();
      } else {
        alert('Failed to delete run: ' + result.error);
      }
    } catch (error) {
      console.error('Failed to delete run:', error);
      alert('Failed to delete run');
    }
  };

  const handleClearAll = async () => {
    if (runs.length === 0) {
      alert('No runs to delete.');
      return;
    }

    if (!confirm(`Delete ALL ${runs.length} runs? This cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch('/api/runs?all=true', { method: 'DELETE' });
      const result = await response.json();
      if (result.success) {
        fetchRuns();
      } else {
        alert('Failed to clear runs: ' + result.error);
      }
    } catch (error) {
      console.error('Failed to clear runs:', error);
      alert('Failed to clear runs');
    }
  };

  const getStatusBadge = (status: string) => {
    const statusMap: Record<string, { class: string; label: string }> = {
      completed: { class: 'badge-success', label: '✅ Complete' },
      'waiting-for-review': { class: 'badge-info', label: '👀 Ready for Review' },
      failed: { class: 'badge-danger', label: '❌ Failed' },
      cancelled: { class: 'badge-muted', label: '🚫 Cancelled' },
      pending: { class: 'badge-muted', label: '⏳ Pending' },
    };

    const config = statusMap[status] || { class: 'badge-muted', label: status };
    return <span className={`badge ${config.class}`}>{config.label}</span>;
  };

  // Render inline progress for active runs
  const renderProgressCell = (run: Run) => {
    if (!isActiveRun(run.status)) {
      return getStatusBadge(run.status);
    }

    return (
      <div className="space-y-1.5 min-w-[180px]">
        <div className="flex items-center gap-2">
          <span className="badge badge-info text-xs animate-pulse whitespace-nowrap">
            {run.currentStep || run.status}
          </span>
        </div>
        <div className="h-1.5 bg-[var(--card-border)] rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-[var(--primary)] to-[var(--secondary)] transition-all duration-300"
            style={{ width: `${run.progress || 0}%` }}
          />
        </div>
        <div className="text-xs text-[var(--muted)]">
          {Math.round(run.progress || 0)}% complete
        </div>
      </div>
    );
  };

  // Render properties count with live animation for active runs
  const renderPropertiesCell = (run: Run) => {
    if (isActiveRun(run.status)) {
      return (
        <span className="text-lg font-bold text-blue-400 animate-pulse">
          {run.propertiesExtracted || 0}
        </span>
      );
    }
    // For completed runs, show deduped count (the actual unique properties)
    return run.propertiesDeduped ?? run.propertiesExtracted ?? '-';
  };

  // Render market status cell (only shown when market status checking is enabled)
  // Currently disabled by default - uncomment when API is integrated
  // const renderMarketStatusCell = (run: Run) => {
  //   // Show spinner during availability check
  //   if (run.status === 'checking-availability') {
  //     return (
  //       <div className="flex items-center gap-2">
  //         <div className="animate-spin h-4 w-4 border-2 border-blue-500 border-t-transparent rounded-full"></div>
  //         <span className="text-xs text-blue-400">Checking...</span>
  //       </div>
  //     );
  //   }
  //
  //   // Show unavailable count if available
  //   if (run.propertiesUnavailable !== null && run.propertiesUnavailable > 0) {
  //     const availableCount = (run.propertiesDeduped || 0) - run.propertiesUnavailable;
  //     return (
  //       <div className="flex flex-col gap-0.5">
  //         <span className="text-xs text-green-400">{availableCount} available</span>
  //         <span className="text-xs text-red-400">{run.propertiesUnavailable} sold/pending</span>
  //       </div>
  //     );
  //   }
  //
  //   // Show all available if checked but none unavailable
  //   if (run.propertiesDeduped !== null && run.propertiesUnavailable === 0) {
  //     return <span className="text-xs text-green-400">All available</span>;
  //   }
  //
  //   // Not yet checked
  //   return <span className="text-xs text-[var(--muted)]">-</span>;
  // };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Calculate stats (use deduped count when available for accuracy)
  const totalRuns = runs.length;
  const totalProperties = runs.reduce((sum, r) => sum + (r.propertiesDeduped ?? r.propertiesExtracted ?? 0), 0);
  const totalTopDeals = runs.reduce((sum, r) => sum + (r.topNCount || 0), 0);
  const completedRuns = runs.filter(r => r.status === 'completed').length;

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold gradient-text">
              Section 8 BRRRR Analyzer
            </h1>
            <p className="text-[var(--muted)] mt-1">
              Automate your property deal analysis pipeline
            </p>
          </div>
          <div className="flex gap-4">
            <Link href="/settings" className="btn btn-secondary">
              ⚙️ Settings
            </Link>
            <button
              onClick={() => setShowUpload(true)}
              className="btn btn-primary"
            >
              📤 Upload PDF
            </button>
          </div>
        </header>

        {/* Upload Modal */}
        {showUpload && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="relative w-full max-w-2xl">
              <button
                onClick={() => setShowUpload(false)}
                className="absolute -top-12 right-0 text-white hover:text-[var(--primary)]"
              >
                ✕ Close
              </button>
              <UploadWizard onComplete={handleUploadComplete} />
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="stat-card">
            <div className="stat-value">{totalRuns}</div>
            <div className="stat-label">Total Runs</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{totalProperties.toLocaleString()}</div>
            <div className="stat-label">Properties Analyzed</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{totalTopDeals}</div>
            <div className="stat-label">Top Deals Found</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{completedRuns}</div>
            <div className="stat-label">Completed Runs</div>
          </div>
        </div>

        {/* Recent Runs */}
        <div className="card">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold">📁 Recent Runs</h2>
            <div className="flex gap-2">
              <button onClick={fetchRuns} className="btn btn-secondary text-sm">
                🔄 Refresh
              </button>
              {runs.length > 0 && (
                <button
                  onClick={handleClearAll}
                  className="btn text-sm bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30"
                >
                  🗑️ Clear All
                </button>
              )}
            </div>
          </div>

          {loading ? (
            <div className="text-center py-12">
              <div className="text-4xl animate-pulse mb-4">⏳</div>
              <p className="text-[var(--muted)]">Loading runs...</p>
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-4">📭</div>
              <p className="text-lg font-medium mb-2">No runs yet</p>
              <p className="text-[var(--muted)] mb-6">
                Upload your first Section 8 property list PDF to get started
              </p>
              <button
                onClick={() => setShowUpload(true)}
                className="btn btn-primary"
              >
                Upload PDF
              </button>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Status</th>
                  <th>Properties</th>
                  <th>Top Deals</th>
                  <th>Date</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className={isActiveRun(run.status) ? 'bg-blue-500/5' : ''}>
                    <td>
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">
                          {isActiveRun(run.status) ? '⚙️' : '📄'}
                        </span>
                        <span className="font-medium truncate max-w-[200px]">
                          {run.fileName}
                        </span>
                      </div>
                    </td>
                    <td>{renderProgressCell(run)}</td>
                    <td>{renderPropertiesCell(run)}</td>
                    <td>
                      {run.topNCount !== null ? (
                        <span className="font-bold text-[var(--success)]">
                          {run.topNCount}
                        </span>
                      ) : '-'}
                    </td>
                    <td className="text-[var(--muted)] text-sm">
                      {formatDate(run.createdAt)}
                    </td>
                    <td>
                      <div className="flex gap-2">
                        <Link
                          href={`/run/${run.id}`}
                          className="btn btn-secondary text-sm py-2 px-4"
                        >
                          {isActiveRun(run.status) ? 'Details' : 'View →'}
                        </Link>
                        <button
                          onClick={() => handleDeleteRun(run.id, run.fileName)}
                          className="btn text-sm py-2 px-3 bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30"
                          title="Delete run"
                        >
                          🗑️
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Quick Start Guide */}
        {runs.length === 0 && (
          <div className="mt-8 card bg-gradient-to-br from-[var(--primary)]/10 to-[var(--secondary)]/10 border-[var(--primary)]/30">
            <h3 className="text-lg font-bold mb-4">🚀 Quick Start Guide</h3>
            <div className="grid md:grid-cols-3 gap-6">
              <div className="flex gap-4">
                <span className="text-2xl">1️⃣</span>
                <div>
                  <p className="font-medium">Upload PDF</p>
                  <p className="text-sm text-[var(--muted)]">
                    Upload your Section 8 property list PDF
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <span className="text-2xl">2️⃣</span>
                <div>
                  <p className="font-medium">Auto-Analyze</p>
                  <p className="text-sm text-[var(--muted)]">
                    OCR, parse, filter, underwrite, and rank
                  </p>
                </div>
              </div>
              <div className="flex gap-4">
                <span className="text-2xl">3️⃣</span>
                <div>
                  <p className="font-medium">Get Top Deals</p>
                  <p className="text-sm text-[var(--muted)]">
                    Download your PDF report with top N deals
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
