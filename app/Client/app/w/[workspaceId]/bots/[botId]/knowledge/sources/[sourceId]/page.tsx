'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { getBot, type Bot } from '@/lib/api/bots';
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
import { useWorkspace } from '@/lib/workspace-context';
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
  const { workspaceId, viewerRole, setPageBreadcrumbs } = useWorkspace();

  const [bot, setBot] = useState<Bot | null>(null);
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
      } catch {
        toast('Failed to load document', 'error');
        router.replace(`/w/${workspaceId}/bots`);
      }
    }

    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.botId, params.sourceId]);

  useEffect(() => {
    if (!bot) return;

    setPageBreadcrumbs([
      { label: bot.name, href: `/w/${workspaceId}/bots/${bot.id}` },
      {
        label: 'Knowledge Base',
        href: `/w/${workspaceId}/bots/${bot.id}/knowledge`,
      },
      { label: source?.filename ?? 'Document' },
    ]);
  }, [bot, setPageBreadcrumbs, source?.filename, workspaceId]);

  useEffect(() => () => setPageBreadcrumbs([]), [setPageBreadcrumbs]);

  const canManage = hasWorkspacePermission(viewerRole, WORKSPACE_PERMISSIONS.KNOWLEDGE_MANAGE);
  const knowledgePath = `/w/${workspaceId}/bots/${params.botId}/knowledge`;

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteSource(params.sourceId);
      toast('Document deleted', 'success');
      router.push(knowledgePath);
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
      <Link
        href={knowledgePath}
        className="mb-3 inline-flex items-center gap-1.5 rounded-sm text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        Back to knowledge
      </Link>

      {loadError || !source ? (
        <div className="rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground flex items-center justify-between gap-4">
          {loadError || 'This document could not be loaded.'}
          <Link href={knowledgePath}>
            <Button variant="secondary" size="sm">
              Back to knowledge
            </Button>
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground break-all">
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
            <div className="rounded-lg bg-error-bg border border-destructive/20 px-3 py-2 text-sm text-error-bg-foreground mb-5">
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
