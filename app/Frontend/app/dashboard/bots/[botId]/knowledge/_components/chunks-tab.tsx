'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Edit, Layers, Trash2 } from 'lucide-react';
import {
  bulkChunkAction,
  deleteChunk,
  listChunks,
  updateChunk,
  type BulkChunkAction,
  type KnowledgeChunk,
} from '@/lib/api/knowledgeChunks';
import { listSources, type SourceListItem } from '@/lib/api/knowledgeSources';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { ChunkEditorDialog } from './chunk-editor-dialog';

const PAGE_SIZE = 20;

/** How much of a chunk the list shows before it becomes unreadable as a row. */
const PREVIEW_LENGTH = 100;

type EnabledFilter = '' | 'true' | 'false';

interface ChunksTabProps {
  botId: string;
  canManage: boolean;
  /**
   * Locks the list to one document and hides the source column and filter.
   *
   * The source detail page is this same list with one fewer degree of freedom, so it reuses
   * the component rather than maintaining a second copy — the two would otherwise drift
   * apart on the parts that matter: bulk scoping, the toggle, and the delete confirmation.
   */
  sourceId?: string;
  onChanged?: () => void;
}

/**
 * The searchable, filterable chunk list (section 15.4).
 *
 * Every filter is a server query parameter. Searching or filtering what has already been
 * fetched would only ever search the current page, which is the one thing a user filtering
 * a 4,000-chunk bot is not trying to do.
 */
export function ChunksTab({ botId, canManage, sourceId, onChanged }: ChunksTabProps) {
  const { toast } = useToast();

  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>('');
  const [sources, setSources] = useState<SourceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyChunkId, setBusyChunkId] = useState<string | null>(null);
  const [editing, setEditing] = useState<KnowledgeChunk | null>(null);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeChunk | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const effectiveSourceId = sourceId ?? sourceFilter;

  const load = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (options.silent) setRefreshing(true);

      try {
        const result = await listChunks(botId, {
          ...(search ? { search } : {}),
          ...(effectiveSourceId ? { sourceId: effectiveSourceId } : {}),
          ...(enabledFilter ? { enabled: enabledFilter === 'true' } : {}),
          page,
          limit: PAGE_SIZE,
        });
        setChunks(result.chunks);
        setTotal(result.pagination.total);
        setTotalPages(result.pagination.totalPages);
        setLoadError('');
      } catch {
        setLoadError('Chunks could not be loaded.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [botId, search, effectiveSourceId, enabledFilter, page],
  );

  useEffect(() => {
    // The loader writes state only after its request resolves, so this effect's body
    // performs no synchronous state write — the rule cannot see through the async boundary
    // and flags the call regardless.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // The source filter's options come from the bot's documents. Skipped entirely when the
  // list is already locked to one source, which is the source detail page's case.
  useEffect(() => {
    if (sourceId) return;

    listSources(botId, { limit: 100 })
      .then((result) => setSources(result.sources))
      .catch(() => {
        // Left empty rather than surfaced: the filter is a convenience, and the chunk list
        // itself is unaffected. An error banner over a working list would be noise.
      });
  }, [botId, sourceId]);

  /**
   * Selection is cleared whenever the visible rows change.
   *
   * A selection is a set of ids the user picked *from this list*. After a page turn or a
   * filter change, some of those ids are no longer on screen, and a bulk action would then
   * affect rows the user cannot see and did not re-confirm.
   *
   * Cleared by the handlers that change what is shown rather than by an effect watching
   * them: the reset belongs to the interaction, and doing it here means the two cannot get
   * out of step when a new filter is added.
   */
  function clearSelection() {
    setSelected(new Set());
  }

  function changePage(next: number) {
    setPage(next);
    clearSelection();
  }

  function changeSearch(value: string) {
    setSearch(value);
    setPage(1);
    clearSelection();
  }

  function changeSourceFilter(value: string) {
    setSourceFilter(value);
    setPage(1);
    clearSelection();
  }

  function changeEnabledFilter(value: EnabledFilter) {
    setEnabledFilter(value);
    setPage(1);
    clearSelection();
  }

  async function handleToggle(chunk: KnowledgeChunk, enabled: boolean) {
    setBusyChunkId(chunk.id);

    // Applied locally first so the switch responds immediately; reverted below if the
    // request fails. The alternative — leaving it until the server answers — makes a
    // toggle feel broken on a slow connection.
    setChunks((prev) =>
      prev.map((item) => (item.id === chunk.id ? { ...item, enabled } : item)),
    );

    try {
      const updated = await updateChunk(chunk.id, { enabled });
      setChunks((prev) => prev.map((item) => (item.id === chunk.id ? updated : item)));
      onChanged?.();
    } catch (err) {
      setChunks((prev) =>
        prev.map((item) => (item.id === chunk.id ? { ...item, enabled: chunk.enabled } : item)),
      );
      toast(err instanceof ApiError ? err.message : 'Failed to update chunk', 'error');
    } finally {
      setBusyChunkId(null);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;

    setBusy(true);
    try {
      await deleteChunk(pendingDelete.id);
      toast('Chunk deleted', 'success');
      setPendingDelete(null);

      const isLastRowOnPage = chunks.length === 1 && page > 1;
      if (isLastRowOnPage) {
        setPage((current) => current - 1);
      } else {
        await load();
      }
      onChanged?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to delete chunk', 'error');
      setPendingDelete(null);
    } finally {
      setBusy(false);
    }
  }

  async function runBulk(action: BulkChunkAction) {
    const ids = [...selected];
    if (ids.length === 0) return;

    setBusy(true);
    try {
      const result = await bulkChunkAction(botId, action, ids);
      toast(
        `${result.affected} chunk${result.affected === 1 ? '' : 's'} ${
          action === 'delete' ? 'deleted' : `${action}d`
        }`,
        'success',
      );
      setSelected(new Set());
      setPendingBulkDelete(false);

      // Deleting can empty the last page, so the reload starts from a page that exists.
      if (action === 'delete' && chunks.length === ids.length && page > 1) {
        setPage((current) => current - 1);
      } else {
        await load();
      }
      onChanged?.();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `Failed to ${action} chunks`, 'error');
      setPendingBulkDelete(false);
    } finally {
      setBusy(false);
    }
  }

  function handleSaved(updated: KnowledgeChunk) {
    setChunks((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    onChanged?.();
  }

  const allOnPageSelected = chunks.length > 0 && chunks.every((chunk) => selected.has(chunk.id));
  const someSelected = selected.size > 0 && !allOnPageSelected;

  function toggleAll() {
    if (allOnPageSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(chunks.map((chunk) => chunk.id)));
    }
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  const filtersActive = search !== '' || enabledFilter !== '' || sourceFilter !== '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px]">
          <SearchInput
            value={search}
            onChange={changeSearch}
            placeholder="Search chunk content…"
          />
        </div>

        {!sourceId && (
          <div className="w-52">
            <Select
              id="chunk-source-filter"
              aria-label="Filter by document"
              value={sourceFilter}
              onChange={(e) => changeSourceFilter(e.target.value)}
              options={[
                { value: '', label: 'All documents' },
                ...sources.map((source) => ({ value: source.id, label: source.filename })),
              ]}
            />
          </div>
        )}

        <div className="w-40">
          <Select
            id="chunk-enabled-filter"
            aria-label="Filter by state"
            value={enabledFilter}
            onChange={(e) => changeEnabledFilter(e.target.value as EnabledFilter)}
            options={[
              { value: '', label: 'Enabled & disabled' },
              { value: 'true', label: 'Enabled only' },
              { value: 'false', label: 'Disabled only' },
            ]}
          />
        </div>

        {refreshing && <Spinner size="sm" />}
      </div>

      {/* Bulk bar. Appears only with a selection, and states the count, so an action can
          never be fired against rows the user has lost track of. */}
      {canManage && selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <span className="text-sm text-muted-foreground">
            {selected.size} chunk{selected.size === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => runBulk('enable')}>
              Enable
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => runBulk('disable')}>
              Disable
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => setPendingBulkDelete(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
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
      ) : chunks.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={filtersActive ? 'No chunks match these filters' : 'No chunks yet'}
          description={
            filtersActive
              ? 'Try a different search term, document, or state.'
              : 'Chunks appear here once a document has been uploaded and processed.'
          }
        />
      ) : (
        <>
          <div className="rounded-xl border border-border overflow-hidden">
            <div className="hidden md:flex items-center gap-3 px-4 py-2 border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground">
              {canManage && (
                <Checkbox
                  label="Select all chunks on this page"
                  checked={allOnPageSelected}
                  indeterminate={someSelected}
                  onChange={toggleAll}
                />
              )}
              <span className="flex-1">Content</span>
              {!sourceId && <span className="w-40">Source</span>}
              <span className="w-12">Page</span>
              <span className="w-16">Version</span>
              {canManage && <span className="w-24 text-right">Actions</span>}
            </div>

            <ul className="divide-y divide-border">
              {chunks.map((chunk) => (
                <li key={chunk.id} className="px-4 py-3 flex flex-wrap md:flex-nowrap items-start gap-3">
                  {canManage && (
                    <div className="pt-0.5">
                      <Checkbox
                        label={`Select chunk ${chunk.chunkIndex + 1}`}
                        checked={selected.has(chunk.id)}
                        onChange={(checked) => toggleOne(chunk.id, checked)}
                      />
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-foreground leading-relaxed">
                      {chunk.content.length > PREVIEW_LENGTH
                        ? `${chunk.content.slice(0, PREVIEW_LENGTH).trimEnd()}…`
                        : chunk.content}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-muted-foreground">
                      <span>Chunk #{chunk.chunkIndex + 1}</span>
                      {chunk.topic && <span>{chunk.topic}</span>}
                      {/* The source is shown inline on small screens, where the column is
                          hidden — losing the provenance entirely would leave a chunk of
                          text with no indication of where it came from. */}
                      {!sourceId && (
                        <Link
                          href={`/dashboard/bots/${botId}/knowledge/sources/${chunk.sourceId}`}
                          className="md:hidden hover:text-foreground transition-colors"
                        >
                          {chunk.source.filename}
                        </Link>
                      )}
                    </div>
                  </div>

                  {!sourceId && (
                    <div className="hidden md:block w-40 shrink-0">
                      <Link
                        href={`/dashboard/bots/${botId}/knowledge/sources/${chunk.sourceId}`}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors truncate block"
                        title={chunk.source.filename}
                      >
                        {chunk.source.filename}
                      </Link>
                    </div>
                  )}

                  <div className="hidden md:block w-12 shrink-0 text-xs text-muted-foreground">
                    {chunk.pageNumber ?? '—'}
                  </div>

                  <div className="hidden md:block w-16 shrink-0 text-xs text-muted-foreground">
                    v{chunk.version}
                  </div>

                  <div className="flex items-center gap-2 shrink-0 md:w-24 md:justify-end">
                    <Switch
                      label={`Chunk ${chunk.chunkIndex + 1} enabled`}
                      checked={chunk.enabled}
                      loading={busyChunkId === chunk.id}
                      disabled={!canManage}
                      onChange={(next) => handleToggle(chunk, next)}
                    />
                    {canManage && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-2"
                          aria-label={`Edit chunk ${chunk.chunkIndex + 1}`}
                          onClick={() => setEditing(chunk)}
                        >
                          <Edit className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                          aria-label={`Delete chunk ${chunk.chunkIndex + 1}`}
                          onClick={() => setPendingDelete(chunk)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            itemLabel="chunk"
            onPageChange={changePage}
            disabled={refreshing}
          />
        </>
      )}

      {/* Keyed by the chunk, so opening a different one remounts the editor and seeds the
          textarea from that chunk's text. An effect syncing on `chunk` would be a second
          source of truth for what is in the box. */}
      {editing && (
        <ChunkEditorDialog
          key={editing.id}
          chunk={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete Chunk"
        confirmLabel="Delete Chunk"
        loading={busy}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDelete}
        description={
          <>
            <p>
              This chunk will be removed from the database and the vector store. The bot will no
              longer retrieve it.
            </p>
            <p className="text-foreground">
              {pendingDelete?.content.slice(0, PREVIEW_LENGTH)}
              {(pendingDelete?.content.length ?? 0) > PREVIEW_LENGTH ? '…' : ''}
            </p>
            <p className="font-medium text-destructive">This action cannot be undone.</p>
          </>
        }
      />

      <ConfirmDialog
        open={pendingBulkDelete}
        title="Delete Chunks"
        confirmLabel={`Delete ${selected.size} Chunk${selected.size === 1 ? '' : 's'}`}
        loading={busy}
        onClose={() => setPendingBulkDelete(false)}
        onConfirm={() => runBulk('delete')}
        description={
          <>
            <p>
              {selected.size} chunk{selected.size === 1 ? '' : 's'} will be removed from the
              database and the vector store.
            </p>
            <p className="font-medium text-destructive">This action cannot be undone.</p>
          </>
        }
      />
    </div>
  );
}
