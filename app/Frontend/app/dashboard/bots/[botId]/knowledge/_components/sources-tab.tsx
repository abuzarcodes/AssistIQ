'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, Package, Trash2, Upload, Eye } from 'lucide-react';
import {
  deleteSource,
  listSources,
  type KnowledgeSourceStatus,
  type SourceListItem,
} from '@/lib/api/knowledgeSources';
import { Card, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { formatFileSize, formatRelativeTime } from '@/lib/format';
import { ApiError } from '@/lib/api-client';
import { StatusBadge } from './status-badge';
import { UploadDialog } from './upload-dialog';

const PAGE_SIZE = 20;

/** How often to re-read the list while something is still ingesting. */
const POLL_INTERVAL_MS = 4000;

/**
 * How many polls before the automatic refresh gives up.
 *
 * An unbounded poll is a request every four seconds for as long as the tab is open — which
 * is how a stuck `PROCESSING` row turns into a client that quietly hammers the API all
 * afternoon. 45 polls is three minutes, comfortably past a large batch, and when it stops
 * the banner says so instead of leaving the user waiting on a refresh that is no longer
 * happening.
 */
const MAX_POLLS = 45;

/** The two states that mean "work is still happening". */
const IN_FLIGHT: readonly KnowledgeSourceStatus[] = ['PENDING', 'PROCESSING'];

type StatusFilter = '' | KnowledgeSourceStatus;

interface SourcesTabProps {
  botId: string;
  canManage: boolean;
  /** Owned by the page so its "Upload Document" quick action can open this tab's dialog. */
  uploadOpen: boolean;
  onUploadOpenChange: (open: boolean) => void;
  onChanged: () => void;
}

/**
 * The uploaded-documents tab.
 *
 * Pagination, the status filter and the search are all server-side: the list endpoint
 * takes them, and filtering a single page in the browser would show "3 documents" for a
 * bot with three hundred while hiding the rest.
 */
export function SourcesTab({
  botId,
  canManage,
  uploadOpen,
  onUploadOpenChange,
  onChanged,
}: SourcesTabProps) {
  const { toast } = useToast();

  const [sources, setSources] = useState<SourceListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');

  /**
   * How many automatic refreshes this page of results has used.
   *
   * State rather than a ref because the banner has to re-render when the budget runs out,
   * and it is reset by the handlers that change what is on screen — a new page and a new
   * filter each get a full budget, since they are a different question about the data.
   */
  const [pollCount, setPollCount] = useState(0);

  const [pendingDelete, setPendingDelete] = useState<SourceListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (options.silent) setRefreshing(true);

      try {
        const result = await listSources(botId, {
          page,
          limit: PAGE_SIZE,
          ...(status ? { status } : {}),
        });
        setSources(result.sources);
        setTotal(result.pagination.total);
        setTotalPages(result.pagination.totalPages);
        setLoadError('');
      } catch {
        setLoadError('Documents could not be loaded.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [botId, page, status],
  );

  useEffect(() => {
    // The loader writes state only after its request resolves, so this effect's body
    // performs no synchronous state write — the rule cannot see through the async boundary
    // and flags the call regardless.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const inFlight = sources.filter((source) => IN_FLIGHT.includes(source.status));
  const pollsExhausted = inFlight.length > 0 && pollCount >= MAX_POLLS;

  /**
   * Refresh while anything is still ingesting.
   *
   * Ingestion normally finishes inside the upload request, so this is for the row that is
   * genuinely still moving — a batch large enough to be cut short, or a process that died
   * mid-run. Re-reading the list is what turns a `PROCESSING` badge into a `PROCESSED` one
   * without the user reloading the page.
   *
   * The chain is driven by `pollCount`: the timer increments it inside a callback, which
   * re-runs this effect and arms exactly one more timer. That keeps a single refresh in
   * flight at a time, where depending on the response object would let a slow request and
   * its own re-render arm two.
   */
  useEffect(() => {
    if (inFlight.length === 0 || pollCount >= MAX_POLLS) return;

    const timer = setTimeout(() => {
      setPollCount((count) => count + 1);
      load({ silent: true });
    }, POLL_INTERVAL_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollCount, inFlight.length, page, status]);

  /** Changing what is on screen grants a fresh poll budget — see `pollCount`. */
  function changePage(next: number) {
    setPage(next);
    setPollCount(0);
  }

  function changeStatus(next: StatusFilter) {
    setStatus(next);
    setPage(1);
    setPollCount(0);
  }

  async function handleDelete() {
    if (!pendingDelete) return;

    setDeleting(true);
    try {
      await deleteSource(pendingDelete.id);
      toast('Document deleted', 'success');
      setPendingDelete(null);

      // Deleting the last row of the last page would otherwise leave the user staring at
      // an empty page 3 while pages 1 and 2 still have content.
      const isLastRowOnPage = sources.length === 1 && page > 1;
      if (isLastRowOnPage) {
        setPage((current) => current - 1);
      } else {
        await load();
      }
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to delete document', 'error');
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  function handleUploaded() {
    setPage(1);
    // Reloaded here rather than in the effect above: the batch has just written rows and
    // the user is looking at the list, so it should be current before the dialog closes.
    load();
    onChanged();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="w-40">
            <Select
              id="source-status-filter"
              aria-label="Filter by status"
              value={status}
              onChange={(e) => changeStatus(e.target.value as StatusFilter)}
              options={[
                { value: '', label: 'All statuses' },
                { value: 'PROCESSED', label: 'Processed' },
                { value: 'PENDING', label: 'Pending' },
                { value: 'PROCESSING', label: 'Processing' },
                { value: 'FAILED', label: 'Failed' },
              ]}
            />
          </div>
          {refreshing && <Spinner size="sm" />}
        </div>

        {canManage && (
          <Button size="sm" onClick={() => onUploadOpenChange(true)}>
            <Upload className="h-3.5 w-3.5" />
            Upload Documents
          </Button>
        )}
      </div>

      {/* The count is what makes this determinate: "2 of 9 still processing" says how much
          is left, where a bare spinner only says that something is. It is phrased from the
          in-flight side because that is the number the client can actually observe — see
          the note in the checkpoint about ingestion completing inside the upload request. */}
      {inFlight.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground flex items-center gap-2">
          <Spinner size="sm" />
          <span>
            {inFlight.length} of {sources.length} document
            {sources.length === 1 ? '' : 's'} still processing
            {pollsExhausted
              ? ' — automatic refresh stopped, reopen this tab to check again.'
              : '…'}
          </span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : loadError ? (
        <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground flex items-center justify-between gap-4">
          {loadError}
          <Button variant="secondary" size="sm" onClick={() => load()}>
            Retry
          </Button>
        </div>
      ) : sources.length === 0 ? (
        <EmptyState
          icon={Package}
          title={status ? 'No documents match this filter' : 'No documents uploaded yet'}
          description={
            status
              ? 'Try a different status, or clear the filter to see everything.'
              : 'Upload PDF, DOCX, or text files to teach the bot from your own documentation.'
          }
          action={
            canManage && !status ? (
              <Button size="sm" onClick={() => onUploadOpenChange(true)}>
                <Upload className="h-3.5 w-3.5" />
                Upload Documents
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="space-y-3">
            {sources.map((source) => (
              <Card key={source.id}>
                <CardBody className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-muted text-muted-foreground shrink-0">
                      <FileText className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-foreground truncate">
                          {source.filename}
                        </h3>
                        <StatusBadge status={source.status} />
                        {source.topic && <span className="text-xs text-muted-foreground">{source.topic}</span>}
                      </div>

                      <p className="text-xs text-muted-foreground mt-1">
                        {formatFileSize(source.fileSizeBytes)} ·{' '}
                        {source._count?.chunks ?? 0} chunk
                        {(source._count?.chunks ?? 0) === 1 ? '' : 's'}
                        {typeof source.enabledChunks === 'number' &&
                          ` · ${source.enabledChunks} enabled`}{' '}
                        · added {formatRelativeTime(source.createdAt)}
                      </p>

                      {source.status === 'FAILED' && source.errorMessage && (
                        <p className="text-xs text-destructive mt-1.5">{source.errorMessage}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <Link
                      href={`/dashboard/bots/${botId}/knowledge/sources/${source.id}`}
                      aria-label={`View ${source.filename}`}
                    >
                      <Button variant="ghost" size="sm" className="px-2">
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </Link>
                    {canManage && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                        aria-label={`Delete ${source.filename}`}
                        onClick={() => setPendingDelete(source)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>

          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            itemLabel="document"
            onPageChange={changePage}
            disabled={refreshing}
          />
        </>
      )}

      {/* Mounted only while open, which is also what resets it: closing discards the
          batch, so a half-built queue never reappears on the next open. */}
      {uploadOpen && (
        <UploadDialog
          botId={botId}
          onClose={() => onUploadOpenChange(false)}
          onUploaded={handleUploaded}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete Document"
        confirmLabel="Delete Document"
        loading={deleting}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDelete}
        description={
          <>
            <p>
              <span className="text-foreground font-medium">{pendingDelete?.filename}</span> and
              all {pendingDelete?._count?.chunks ?? 0} of its chunks will be removed from the
              database and the vector store. The bot will no longer answer from this document.
            </p>
            <p className="font-medium text-destructive">This action cannot be undone.</p>
          </>
        }
      />
    </div>
  );
}
