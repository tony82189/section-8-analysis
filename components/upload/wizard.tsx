'use client';

import { useState, useEffect } from 'react';
import FileDropzone from './dropzone';

interface UploadWizardProps {
    onComplete: (result: any) => void;
}

interface UploadState {
    step: 'select' | 'options' | 'uploading' | 'processing' | 'review_ready' | 'complete' | 'error';
    file: File | null;
    dryRun: boolean;
    progress: number;
    progressMessage: string;
    result: any | null;
    error: string | null;
    runId?: string;
    propertiesExtracted: number; // Add live tracking
}

export default function UploadWizard({ onComplete }: UploadWizardProps) {
    const [state, setState] = useState<UploadState>({
        step: 'select',
        file: null,
        dryRun: false,
        progress: 0,
        progressMessage: '',
        result: null,
        error: null,
        propertiesExtracted: 0,
    });

    const handleFileSelect = (file: File) => {
        setState(prev => ({ ...prev, file, step: 'options' }));
    };

    // Polling hook
    useEffect(() => {
        let intervalId: NodeJS.Timeout;

        if (state.step === 'processing' && state.runId) {
            intervalId = setInterval(async () => {
                try {
                    const listRes = await fetch('/api/runs');
                    const listData = await listRes.json();

                    if (listData.success && listData.data.runs) {
                        const run = listData.data.runs.find((r: any) => r.id === state.runId);

                        if (run) {
                            const currentProps = run.propertiesExtracted || 0;

                            // If status is 'waiting-for-review' -> Go to completion screen (intermission)
                            if (run.status === 'waiting-for-review' || run.status === 'completed') {
                                setState(prev => ({
                                    ...prev,
                                    step: 'review_ready',
                                    progress: 100,
                                    propertiesExtracted: currentProps,
                                    result: {
                                        runId: run.id,
                                        propertiesCount: run.propertiesDeduped || currentProps,
                                    }
                                }));
                            } else if (run.status === 'failed') {
                                setState(prev => ({
                                    ...prev,
                                    step: 'error',
                                    error: run.error || 'Processing failed'
                                }));
                            } else {
                                // Still processing
                                const message = run.currentStep || `Status: ${run.status}`;

                                setState(prev => ({
                                    ...prev,
                                    progress: run.progress || prev.progress,
                                    progressMessage: message,
                                    propertiesExtracted: currentProps,
                                }));
                            }
                        }
                    }
                } catch (e) {
                    console.error('Polling error', e);
                }
            }, 1000);
        }

        return () => clearInterval(intervalId);
    }, [state.step, state.runId]);

    const handleStartAnalysis = async () => {
        if (!state.file) return;

        setState(prev => ({
            ...prev,
            step: 'uploading',
            progress: 0,
            progressMessage: 'Uploading file...'
        }));

        try {
            const formData = new FormData();
            formData.append('file', state.file);
            formData.append('dryRun', String(state.dryRun));

            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData,
            });

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.error || 'Upload failed');
            }

            // Immediately switch to polling
            setState(prev => ({
                ...prev,
                step: 'processing',
                runId: result.data.runId,
                progress: 5,
                progressMessage: 'Initializing pipeline...',
                propertiesExtracted: 0,
            }));

        } catch (err) {
            const message = err instanceof Error ? err.message : 'An error occurred';
            setState(prev => ({
                ...prev,
                step: 'error',
                error: message
            }));
        }
    };

    const handleReset = () => {
        setState({
            step: 'select',
            file: null,
            dryRun: false,
            progress: 0,
            progressMessage: '',
            result: null,
            error: null,
            propertiesExtracted: 0,
        });
    };

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    };

    return (
        <div className="card max-w-2xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold">
                    {state.step === 'select' && '📤 Upload PDF'}
                    {state.step === 'options' && '⚙️ Analysis Options'}
                    {state.step === 'uploading' && '⏳ Uploading...'}
                    {state.step === 'processing' && '🔄 Processing...'}
                    {state.step === 'review_ready' && '✅ Extraction Complete'}
                    {state.step === 'complete' && '✅ Complete'}
                    {state.step === 'error' && '❌ Error'}
                </h2>
                <span className="badge badge-muted">
                    Step {
                        state.step === 'select' ? '1' :
                            state.step === 'options' ? '2' :
                                state.step === 'uploading' || state.step === 'processing' ? '3' :
                                    '4'
                    } of 4
                </span>
            </div>

            {/* Step: Select File */}
            {state.step === 'select' && (
                <FileDropzone onFileSelect={handleFileSelect} />
            )}

            {/* Step: Options */}
            {state.step === 'options' && state.file && (
                <div className="space-y-6">
                    {/* Selected file info */}
                    <div className="flex items-center gap-4 p-4 bg-[rgba(102,126,234,0.1)] rounded-lg">
                        <span className="text-3xl">📄</span>
                        <div className="flex-1">
                            <p className="font-medium">{state.file.name}</p>
                            <p className="text-sm text-[var(--muted)]">
                                {formatFileSize(state.file.size)}
                            </p>
                        </div>
                        <button
                            onClick={() => setState(prev => ({ ...prev, step: 'select', file: null }))}
                            className="text-[var(--muted)] hover:text-[var(--danger)]"
                        >
                            ✕
                        </button>
                    </div>

                    {/* Dry run toggle */}
                    <div className="flex items-center justify-between p-4 bg-[var(--background)] rounded-lg">
                        <div>
                            <p className="font-medium">Dry Run Mode</p>
                            <p className="text-sm text-[var(--muted)]">
                                Stop after extraction & filter (skip Zillow checks, underwriting, reports)
                            </p>
                        </div>
                        <button
                            onClick={() => setState(prev => ({ ...prev, dryRun: !prev.dryRun }))}
                            className={`toggle ${state.dryRun ? 'active' : ''}`}
                        />
                    </div>

                    {/* Actions */}
                    <div className="flex gap-4">
                        <button
                            onClick={() => setState(prev => ({ ...prev, step: 'select', file: null }))}
                            className="btn btn-secondary flex-1"
                        >
                            ← Back
                        </button>
                        <button
                            onClick={handleStartAnalysis}
                            className="btn btn-primary flex-1"
                        >
                            Start Analysis →
                        </button>
                    </div>
                </div>
            )}

            {/* Step: Processing */}
            {(state.step === 'uploading' || state.step === 'processing') && (
                <div className="space-y-6 py-8">
                    <div className="text-center">
                        <div className="inline-block text-5xl animate-pulse mb-4">
                            {state.step === 'uploading' ? '📤' : '⚙️'}
                        </div>
                        <p className="text-lg font-medium">{state.progressMessage}</p>

                        {/* Live Counter Display */}
                        {state.step === 'processing' && (
                            <div className="mt-4 p-4 bg-blue-500/10 rounded-xl border border-blue-500/20">
                                <span className="text-2xl font-bold text-blue-400">
                                    {state.propertiesExtracted}
                                </span>
                                <p className="text-sm text-blue-200 mt-1 uppercase tracking-wider font-semibold">
                                    Properties Found
                                </p>
                            </div>
                        )}

                        <p className="text-sm text-[var(--muted)] mt-2">
                            {state.step === 'uploading' ? 'Please wait...' : 'Extraction in progress...'}
                        </p>
                    </div>

                    <div className="progress-bar">
                        <div
                            className="progress-bar-fill transition-all duration-500"
                            style={{ width: `${state.progress}%` }}
                        />
                    </div>
                    <p className="text-center text-sm text-[var(--muted)]">
                        {state.progress}% complete
                    </p>
                </div>
            )}

            {/* Step: Review Ready (Intermission) */}
            {state.step === 'review_ready' && state.result && (
                <div className="space-y-6 py-4">
                    <div className="text-center">
                        <div className="text-5xl mb-4 text-[var(--success)]">✓</div>
                        <h3 className="text-xl font-bold mb-2">Extraction Complete</h3>

                        {/* Final Count Display */}
                        <div className="my-6 p-6 bg-[var(--success-bg)] rounded-2xl border border-[var(--success-border)]">
                            <span className="text-4xl font-extrabold text-[var(--success)]">
                                {state.result.propertiesCount}
                            </span>
                            <p className="text-lg text-[var(--muted)] mt-1 font-medium">
                                Total Properties Found
                            </p>
                        </div>
                    </div>

                    <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm text-blue-200 text-center">
                        You can now review the raw data and adjust filtering criteria on the next page.
                    </div>

                    <div className="flex gap-4">
                        <button
                            onClick={handleReset}
                            className="btn btn-secondary flex-1"
                        >
                            Upload Another
                        </button>
                        <a
                            href={`/run/${state.result.runId}`}
                            className="btn btn-primary flex-1"
                        >
                            Review & Analyze →
                        </a>
                    </div>
                </div>
            )}

            {/* Step: Complete (Old/Full Dry Run) */}
            {state.step === 'complete' && state.result && (
                <div className="space-y-6 py-4">
                    <div className="text-center">
                        <div className="text-5xl mb-4">🎉</div>
                        <h3 className="text-xl font-bold mb-2">Analysis Complete!</h3>
                    </div>

                    <div className="flex gap-4">
                        <button
                            onClick={handleReset}
                            className="btn btn-secondary flex-1"
                        >
                            Upload Another
                        </button>
                        <a
                            href={`/run/${state.result.runId}`}
                            className="btn btn-primary flex-1"
                        >
                            View Results →
                        </a>
                    </div>
                </div>
            )}

            {/* Step: Error */}
            {state.step === 'error' && (
                <div className="space-y-6 py-4">
                    <div className="text-center">
                        <div className="text-5xl mb-4">😕</div>
                        <h3 className="text-xl font-bold mb-2">Something went wrong</h3>
                        <p className="text-[var(--danger)]">{state.error}</p>
                    </div>

                    <button
                        onClick={handleReset}
                        className="btn btn-secondary w-full"
                    >
                        Try Again
                    </button>
                </div>
            )}
        </div>
    );
}
