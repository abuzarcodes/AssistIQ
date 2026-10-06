'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Upload, X } from 'lucide-react';
import {
  uploadSources,
  getUploadLimits,
  rejectionDetails,
  type EffectiveUploadLimits,
  type UploadBatchResult,
  type UploadOutcome,
} from '@/lib/api/knowledgeSources';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { formatFileSize } from '@/lib/format';
import { ApiError } from '@/lib/api-client';

/**
 * A file the operator has picked, together with the reason it cannot be uploaded.
 *
 * Rejected files stay in the list rather than disappearing: the operator chose them, so
 * silently dropping one leaves them wondering whether it was queued. `error` also decides
 * which files are submitted — a rejected file is never sent, so the server's count and
 * combined-size rules are not tripped by files that will only come back rejected again.
 */
interface QueuedFile {
  id: string;
  file: File;
  error: string | null;
}

const OUTCOME_STYLES: Record<UploadOutcome, string> = {
  PROCESSED: 'text-[var(--green-600)] dark:text-[var(--green-400)]',
  FAILED: 'text-[var(--red-600)] dark:text-[var(--red-500)]',
  // Same colour as FAILED on purpose: both mean "this file did not make it", and the
  // label is what distinguishes "we refused it" from "it broke during processing".
  REJECTED: 'text-[var(--red-600)] dark:text-[var(--red-500)]',
};

const OUTCOME_LABELS: Record<UploadOutcome, string> = {
  PROCESSED: 'Processed',
  FAILED: 'Failed',
  REJECTED: 'Rejected',
};

interface UploadDialogProps {
  botId: string;
  onClose: () => void;
  /** Called after a batch that created at least one source, so the lists can refresh. */
  onUploaded: () => void;
}

/**
 * Multi-document upload dialog (section 15.11).
 *
 * Launched from the Sources tab rather than from the page header: uploading is what the
 * sources list is for, and a dialog opened from a tab that immediately shows the new rows
 * confirms the result in place.
 *
 * Every bound comes from `getUploadLimits` — nothing here is hardcoded. That is the point
 * of the endpoint: the operator's settings change without a client release, and a
 * hardcoded ceiling would replace an accurate refusal with a server-side surprise.
 *
 * The caller mounts this only while it is open, which is what resets the queue: mounting
 * is opening, so an abandoned batch cannot leak into the next one, and there is no
 * `open` prop for the component to disagree with its parent about.
 */
export function UploadDialog({ botId, onClose, onUploaded }: UploadDialogProps) {
  const { toast } = useToast();

  const [limits, setLimits] = useState<EffectiveUploadLimits | null>(null);
  const [limitsError, setLimitsError] = useState('');
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [topic, setTopic] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [results, setResults] = useState<UploadBatchResult | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queueIdRef = useRef(0);

  /**
   * Why this file cannot be uploaded, or null when it can.
   *
   * The extension is checked as well as the MIME type because the server requires both to
   * agree (`knowledgeSourceService.validateFile`); a browser reports an empty or guessed
   * type for some files, and catching that here is friendlier than a per-file rejection.
   */
  const validateFile = useCallback(
    (file: File, currentLimits: EffectiveUploadLimits | null): string | null => {
      if (!currentLimits) return 'Upload limits are still loading.';

      const dot = file.name.lastIndexOf('.');
      const extension = dot === -1 ? '' : file.name.slice(dot).toLowerCase();

      if (
        !currentLimits.acceptedExtensions.includes(extension) ||
        !currentLimits.acceptedMimeTypes.includes(file.type)
      ) {
        return `Unsupported type. Allowed: ${currentLimits.acceptedExtensions.join(', ')}.`;
      }
      if (file.size > currentLimits.maxFileSizeBytes) {
        return `Too large (${formatFileSize(file.size)}). Maximum is ${formatFileSize(
          currentLimits.maxFileSizeBytes,
        )}.`;
      }
      return null;
    },
    [],
  );

  function addFiles(files: File[]) {
    setResults(null);
    setUploadError('');

    setQueue((prev) => {
      const next = [...prev];

      files.forEach((file) => {
        queueIdRef.current += 1;
        const duplicate = prev.some(
          (item) => item.file.name === file.name && item.file.size === file.size,
        );

        next.push({
          id: `queued-${queueIdRef.current}`,
          file,
          error: duplicate ? 'Already added.' : validateFile(file, limits),
        });
      });

      return next;
    });
  }

  // Fetched once per open, never per file. Re-reading on each open is what makes a
  // platform-owner's settings change visible without a client release (section 12.5).
  // Every state write here happens in a promise callback, so the effect's synchronous body
  // stays a subscription with no cascading render.
  useEffect(() => {
    let cancelled = false;

    getUploadLimits(botId)
      .then((value) => {
        if (!cancelled) setLimits(value);
      })
      .catch(() => {
        // Without limits there is nothing to pre-flight against, so the picker stays
        // blocked rather than allowing a submission the server will reject wholesale.
        if (!cancelled) {
          setLimitsError('Upload limits could not be loaded. Close the dialog and try again.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [botId]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files ?? []));
    // Reset the input so picking the same file again re-adds it, which is how a user
    // retries after fixing something; without this the change event never fires twice.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleDrag(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    addFiles(Array.from(e.dataTransfer.files ?? []));
  }

  async function handleUpload() {
    const accepted = queue.filter((item) => !item.error);
    if (accepted.length === 0) return;

    setUploading(true);
    setUploadError('');

    try {
      const batch = await uploadSources(
        botId,
        accepted.map((item) => item.file),
        topic || undefined,
      );
      setResults(batch);

      // A batch is a per-file report, not a single outcome: nine processed and one
      // unreadable is a partial success, and saying "upload failed" would misdescribe it.
      const { processed, failed, rejected } = batch.summary;
      const parts = [`${processed} processed`];
      if (failed > 0) parts.push(`${failed} failed`);
      if (rejected > 0) parts.push(`${rejected} rejected`);
      toast(parts.join(', '), failed === 0 && rejected === 0 ? 'success' : 'info');

      setQueue([]);
      if (batch.summary.processed > 0 || batch.summary.failed > 0) {
        onUploaded();
      }
    } catch (err) {
      // An all-rejected batch comes back as a 400 carrying the same per-file shape, so it
      // is rendered as results rather than as a banner — the reasons belong next to the
      // filenames they describe.
      const details = rejectionDetails(err);
      if (details) {
        setResults(details);
      } else {
        setUploadError(
          err instanceof ApiError ? err.message : 'Failed to upload and process the documents.',
        );
      }
    } finally {
      setUploading(false);
    }
  }

  const acceptedFiles = queue.filter((item) => !item.error);
  const acceptedBytes = acceptedFiles.reduce((sum, item) => sum + item.file.size, 0);
  const overFileCount = limits ? acceptedFiles.length > limits.maxFilesPerRequest : false;
  const overTotalBytes = limits ? acceptedBytes > limits.maxTotalBytes : false;
  const canSubmit =
    limits !== null && !uploading && acceptedFiles.length > 0 && !overFileCount && !overTotalBytes;

  return (
    <Dialog
      open
      onClose={onClose}
      title="Upload Documents"
      maxWidth="max-w-2xl"
    >
      <div className="space-y-4">
        {limitsError ? (
          <div className="rounded-lg bg-[var(--red-50)] dark:bg-[color-mix(in_srgb,var(--red-600)_10%,transparent)] border border-[var(--red-500)]/20 px-3 py-2 text-sm text-[var(--red-600)] dark:text-[var(--red-500)]">
            {limitsError}
          </div>
        ) : (
          limits && (
            <div className="rounded-lg bg-[var(--blue-50)] dark:bg-[color-mix(in_srgb,var(--blue-500)_15%,transparent)] px-3 py-2 text-sm text-[var(--blue-600)] dark:text-[var(--blue-400)] flex items-start gap-2">
              <FileText className="h-4 w-4 mt-0.5 shrink-0" />
              <p>
                Select up to {limits.maxFilesPerRequest} files,{' '}
                {formatFileSize(limits.maxFileSizeBytes)} each and{' '}
                {formatFileSize(limits.maxTotalBytes)} in total. Each document is extracted,
                chunked, embedded, and stored in the RAG vector database.
              </p>
            </div>
          )
        )}

        {uploadError && (
          <div className="rounded-lg bg-[var(--red-50)] dark:bg-[color-mix(in_srgb,var(--red-600)_10%,transparent)] border border-[var(--red-500)]/20 px-3 py-2 text-sm text-[var(--red-600)] dark:text-[var(--red-500)]">
            {uploadError}
          </div>
        )}

        {/* Per-file results. A list, not a toast: a batch of ten with one unreadable
            PDF is nine successes and one failure, and a single message cannot say that. */}
        {results && (
          <div className="rounded-lg border border-border">
            <div className="px-4 py-2.5 border-b border-border text-sm font-medium text-foreground">
              {results.summary.processed} of {results.summary.total} processed
              {results.summary.failed > 0 && `, ${results.summary.failed} failed`}
              {results.summary.rejected > 0 && `, ${results.summary.rejected} rejected`}
            </div>
            <ul className="divide-y divide-border max-h-72 overflow-y-auto">
              {results.results.map((result, index) => (
                <li key={`${result.filename}-${index}`} className="px-4 py-2.5 flex items-start gap-3">
                  <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground truncate">{result.filename}</p>
                    {result.error && (
                      <p className="text-xs text-muted-foreground mt-0.5">{result.error}</p>
                    )}
                    {result.outcome === 'PROCESSED' && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {result.pagesExtracted ?? 0} pages → {result.chunksCreated ?? 0} chunks
                      </p>
                    )}
                  </div>
                  <span className={`text-xs font-medium shrink-0 ${OUTCOME_STYLES[result.outcome]}`}>
                    {OUTCOME_LABELS[result.outcome]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!results && (
          <>
            {/* Drop zone. Always rendered while the queue is open, so adding a second
                round of files does not require closing and reopening the dialog. */}
            <div
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed cursor-pointer transition-all duration-200 ${
                queue.length > 0 ? 'px-6 py-4' : 'px-6 py-8'
              } ${
                dragActive
                  ? 'border-accent bg-accent/5 scale-[1.01]'
                  : 'border-border hover:border-accent/40 hover:bg-muted/50'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={limits?.acceptedExtensions.join(',')}
                onChange={handleInputChange}
                disabled={!limits}
                className="hidden"
              />

              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-muted text-muted-foreground shrink-0">
                  <Upload className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Drop files here or click to browse
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {limits
                      ? `${limits.acceptedExtensions.join(', ')} up to ${formatFileSize(
                          limits.maxFileSizeBytes,
                        )} each`
                      : 'Loading limits…'}
                  </p>
                </div>
              </div>
            </div>

            {queue.length > 0 && (
              <div className="rounded-lg border border-border">
                <ul className="divide-y divide-border max-h-64 overflow-y-auto">
                  {queue.map((item) => (
                    <li key={item.id} className="px-3 py-2 flex items-center gap-3">
                      <FileText
                        className={`h-4 w-4 shrink-0 ${
                          item.error ? 'text-destructive' : 'text-muted-foreground'
                        }`}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">{item.file.name}</p>
                        <p
                          className={`text-xs truncate ${
                            item.error ? 'text-destructive' : 'text-muted-foreground'
                          }`}
                        >
                          {item.error ?? formatFileSize(item.file.size)}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${item.file.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setQueue((prev) => prev.filter((q) => q.id !== item.id));
                        }}
                        className="rounded-lg p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer shrink-0"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {queue.length > 0 && limits && (
              <p
                className={`text-xs ${
                  overFileCount || overTotalBytes
                    ? 'text-destructive font-medium'
                    : 'text-muted-foreground'
                }`}
              >
                {acceptedFiles.length} of {limits.maxFilesPerRequest} files,{' '}
                {formatFileSize(acceptedBytes)} of {formatFileSize(limits.maxTotalBytes)}
                {overFileCount && ' — too many files'}
                {overTotalBytes && ' — combined size over the limit'}
              </p>
            )}

            <Input
              id="upload-topic"
              label="Topic / Category (Optional)"
              placeholder="e.g. Company Policy, Product Manual"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {results ? 'Close' : 'Cancel'}
          </Button>
          {!results && (
            <Button size="sm" disabled={!canSubmit} loading={uploading} onClick={handleUpload}>
              <Upload className="h-3.5 w-3.5" />
              {uploading
                ? `Uploading ${acceptedFiles.length} ${
                    acceptedFiles.length === 1 ? 'file' : 'files'
                  }…`
                : `Upload ${acceptedFiles.length || ''} ${
                    acceptedFiles.length === 1 ? 'Document' : 'Documents'
                  }`.trim()}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
