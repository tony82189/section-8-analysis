'use client';

import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';

interface FileDropzoneProps {
    onFileSelect: (file: File) => void;
    disabled?: boolean;
    maxSize?: number;
}

export default function FileDropzone({
    onFileSelect,
    disabled = false,
    maxSize = 100 * 1024 * 1024 // 100MB default
}: FileDropzoneProps) {
    const [error, setError] = useState<string | null>(null);

    const onDrop = useCallback((acceptedFiles: File[], rejectedFiles: any[]) => {
        setError(null);

        if (rejectedFiles.length > 0) {
            const rejection = rejectedFiles[0];
            if (rejection.errors[0]?.code === 'file-too-large') {
                setError(`File too large. Maximum size is ${Math.round(maxSize / 1024 / 1024)}MB`);
            } else if (rejection.errors[0]?.code === 'file-invalid-type') {
                setError('Only PDF files are accepted');
            } else {
                setError('Invalid file');
            }
            return;
        }

        if (acceptedFiles.length > 0) {
            onFileSelect(acceptedFiles[0]);
        }
    }, [onFileSelect, maxSize]);

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        accept: {
            'application/pdf': ['.pdf'],
        },
        maxFiles: 1,
        maxSize,
        disabled,
    });

    return (
        <div>
            <div
                {...getRootProps()}
                className={`dropzone ${isDragActive ? 'active' : ''} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
                <input {...getInputProps()} />
                <div className="dropzone-icon">📄</div>
                {isDragActive ? (
                    <p className="text-lg font-medium">Drop the PDF here...</p>
                ) : (
                    <>
                        <p className="text-lg font-medium mb-2">
                            Drag & drop your Section 8 property list PDF
                        </p>
                        <p className="text-sm text-[var(--muted)]">
                            or click to browse (max {Math.round(maxSize / 1024 / 1024)}MB)
                        </p>
                    </>
                )}
            </div>
            {error && (
                <p className="mt-3 text-sm text-[var(--danger)] text-center">{error}</p>
            )}
        </div>
    );
}
