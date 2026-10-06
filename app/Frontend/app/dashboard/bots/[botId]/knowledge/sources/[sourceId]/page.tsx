'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { getBot, type Bot } from '@/lib/api/bots';
import { getWorkspace, type WorkspaceRole } from '@/lib/api/workspaces';
import {
  deleteSource,
  getSource,
  type SourceWithCounts,
} from '@/lib/api/knowledgeSources';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { formatDateTime, formatFileSize } from '@/lib/format';
import { WORKSPACE_PERMISSIONS, hasWorkspacePermission } from '@/lib/permissions';
import { ApiError } from '@/lib/api-client';
import { StatusBadge } from '../../_components/status-badge';
import { ChunksTab } from '../../_components/chunks-tab';

/**
 * One document and everything the bot learned from it (section 15.6).
 *
 * The chunk list is the same component the Chunks tab uses, locked to this source. That is
 * deliberate: the per-source view is the chunk list with one fewer filter, and a separate
 * implementation would be the place where bulk actions quietly stopped being scoped
 * correctly.
 */
export default function SourceDetailPage() {
  const params = useParams<{ botId: string; sourceId: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const [bot, setBot] = useState<Bot | null>(null);
  const [viewerRole, setViewerRole] = useState<WorkspaceRole | undefined>(undefined);
  const [source, setSource] = useState<SourceWithCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadSource = useCallback(async () => {
    try {
      setSource(await getSource(params.sourceId));
      setLoadError('');
    } catch (err) {
      // A 404 is the tenant-blind answer for both "no such source" and "not your source",
      // so it is reported as not found and offers a way back rather than a retry — retrying
      // would fail identically.
      setLoadError(
        err instanceof ApiError && err.status === 404
          ? 'This document does not exist, or is not part of a workspace you belong to.'
          : 'This document could not be loaded.',
      );
    } finally {
      setLoading(false);
    }
  }, [params.sourceId]);

  useEffect(() => {
    async function load() {
      try {
        const botData = await getBot(params.botId);
        setBot(botData);
        await loadSource();

        try {
          const workspace = await getWorkspace(botData.workspaceId);
          setViewerRole(workspace.viewerRole);
        } catch {
          // Undefined grants nothing, so the page renders read-only.
        }
      } catch {
        toast('Failed to load document', 'error');
        router.push(`/dashboard/bots/${params.botId}/knowledge`);
      }
    }

    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.botId, params.sourceId]);

  const canManage = hasWorkspacePermission(viewerRole, WORKSPACE_PERMISSIONS.KNOWLEDGE_MANAGE);

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteSource(params.sourceId);
      toast('Document deleted', 'success');
      router.push(`/dashboard/bots/${params.botId}/knowledge`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to delete document', 'error');
      setDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  }

  if (loading || !bot) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <button
        onClick={() => router.push(`/dashboard/bots/${bot.id}/knowledge`)}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4 cursor-pointer"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Knowledge
      </button>

      {loadError || !source ? (
        <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground flex items-center justify-between gap-4">
          {loadError || 'This document could not be loaded.'}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => router.push(`/dashboard/bots/${bot.id}/knowledge`)}
          >
            Back to Knowledge
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-semibold text-foreground break-all">
                  {source.filename}
                </h1>
                <StatusBadge status={source.status} />
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {formatFileSize(source.fileSizeBytes)} · {source.mimeType}
                {source.topic && ` · ${source.topic}`} · added {formatDateTime(source.createdAt)}
              </p>
            </div>

            {canManage && (
              <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete Document
              </Button>
            )}
          </div>

          {source.status === 'FAILED' && source.errorMessage && (
            <div className="rounded-lg bg-[var(--red-50)] dark:bg-[color-mix(in_srgb,var(--red-600)_10%,transparent)] border border-[var(--red-500)]/20 px-3 py-2 text-sm text-[var(--red-600)] dark:text-[var(--red-500)] mb-5">
              <p className="font-medium">Processing failed</p>
              <p className="mt-0.5">{source.errorMessage}</p>
            </div>
          )}

          {/* The same numbers the list shows, spelled out here because this is the page
              where the question "how much of this is actually in use?" gets asked. */}
          <div className="grid grid-cols-3 gap-3 mb-6">
            {[
              { label: 'Chunks', value: source._count.chunks },
              { label: 'Enabled', value: source.enabledChunks },
              { label: 'Disabled', value: source.disabledChunks },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-xl border border-border bg-card px-4 py-3"
              >
                <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
                <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">
                  {item.value}
                </p>
              </div>
            ))}
          </div>

          <h2 className="text-sm font-semibold text-foreground mb-3">Chunks</h2>
          <ChunksTab
            botId={bot.id}
            sourceId={source.id}
            canManage={canManage}
            onChanged={loadSource}
          />
        </>
      )}

      <ConfirmDialog
        open={deleteOpen}
        title="Delete Document"
        confirmLabel="Delete Document"
        loading={deleting}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        description={
          <>
            <p>
              <span className="text-foreground font-medium">{source?.filename}</span> and all{' '}
              {source?._count.chunks ?? 0} of its chunks will be removed from the database and
              the vector store.
            </p>
            <p className="font-medium text-destructive">This action cannot be undone.</p>
          </>
        }
      />
    </div>
  );
}
