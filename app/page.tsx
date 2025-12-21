'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import UploadWizard from '@/components/upload/wizard';

interface Run {
  id: string;
  fileName: string;
  status: string;
  propertiesExtracted: number | null;
  topNCount: number | null;
  createdAt: string;
  completedAt: string | null;
}

export default function Dashboard() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);

  useEffect(() => {
    fetchRuns();
  }, []);

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

  const handleUploadComplete = (result: any) => {
    setShowUpload(false);
    fetchRuns();
  };

  const getStatusBadge = (status: string) => {
    const statusMap: Record<string, { class: string; label: string }> = {
      completed: { class: 'badge-success', label: '✅ Complete' },
      processing: { class: 'badge-info', label: '🔄 Processing' },
      failed: { class: 'badge-danger', label: '❌ Failed' },
      pending: { class: 'badge-muted', label: '⏳ Pending' },
    };

    const config = statusMap[status] || { class: 'badge-muted', label: status };
    return <span className={`badge ${config.class}`}>{config.label}</span>;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Calculate stats
  const totalRuns = runs.length;
  const totalProperties = runs.reduce((sum, r) => sum + (r.propertiesExtracted || 0), 0);
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
            <button onClick={fetchRuns} className="btn btn-secondary text-sm">
              🔄 Refresh
            </button>
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
                  <tr key={run.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">📄</span>
                        <span className="font-medium truncate max-w-[200px]">
                          {run.fileName}
                        </span>
                      </div>
                    </td>
                    <td>{getStatusBadge(run.status)}</td>
                    <td>{run.propertiesExtracted ?? '-'}</td>
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
                      <Link
                        href={`/run/${run.id}`}
                        className="btn btn-secondary text-sm py-2 px-4"
                      >
                        View →
                      </Link>
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
