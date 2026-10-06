'use client';

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Edit, Plus, Trash2 } from 'lucide-react';
import {
  createKnowledge,
  deleteAllKnowledge,
  deleteKnowledge,
  listKnowledge,
  updateKnowledge,
  type KnowledgeEntry,
} from '@/lib/api/knowledge';
import { Card, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';

interface FaqTabProps {
  botId: string;
  botName: string;
  /** Whether the caller holds `knowledge:manage`. Presentation only — the server decides. */
  canManage: boolean;
  /**
   * Whether the create form is open. Owned by the page so its "Add FAQ Entry" quick action
   * can raise this tab's dialog, and so the dialog closes when the user leaves the tab.
   */
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  /** Fired when the entry set changes, so the page can refresh its stats. */
  onChanged: () => void;
}

/**
 * The FAQ entries tab — the knowledge page's original content, preserved.
 *
 * Everything the page used to do with FAQ entries still happens here: list, create, edit,
 * delete one, delete all. Only the chrome moved. The one behaviour worth keeping visible
 * is the 501 on single delete (`deleteKnowledge`), which is a documented gap in the AI
 * service rather than a transient failure, so it is reported as information rather than
 * as an error the user should retry.
 */
export function FaqTab({
  botId,
  botName,
  canManage,
  createOpen,
  onCreateOpenChange,
  onChanged,
}: FaqTabProps) {
  const { toast } = useToast();

  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries(await listKnowledge(botId));
      setLoadError('');
    } catch {
      // Inline rather than a toast. A toast disappears while the list stays empty, which
      // leaves the tab looking like a bot with no knowledge rather than a failed request.
      setLoadError('Knowledge entries could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    // The loader writes state only after its request resolves, so this effect's body
    // performs no synchronous state write — the rule cannot see through the async boundary
    // and flags the call regardless.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  function openCreate() {
    setEditingId(null);
    setTitle('');
    setCategory('');
    setQuestion('');
    setAnswer('');
    setFormError('');
    onCreateOpenChange(true);
  }

  function openEdit(entry: KnowledgeEntry) {
    setEditingId(entry.id);
    setTitle(entry.title || '');
    setCategory(entry.category || '');
    setQuestion(entry.question);
    setAnswer(entry.answer);
    setFormError('');
    onCreateOpenChange(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    setSaving(true);

    try {
      if (editingId) {
        await updateKnowledge(editingId, {
          title: title || undefined,
          category: category || undefined,
          question,
          answer,
        });
        toast('Knowledge entry updated', 'success');
      } else {
        await createKnowledge(botId, {
          title: title || undefined,
          category: category || undefined,
          question,
          answer,
        });
        toast('Knowledge added and sent to AI ingestion', 'success');
      }
      onCreateOpenChange(false);
      await load();
      onChanged();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to save knowledge');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;

    setDeleting(true);
    try {
      await deleteKnowledge(pendingDelete.id);
      toast('Knowledge entry deleted', 'success');
      setPendingDelete(null);
      await load();
      onChanged();
    } catch (err) {
      // A 501 is a documented gap in the AI service, not a transient fault, so the message
      // tells the user what to do instead of inviting a retry that will fail identically.
      if (err instanceof ApiError && err.status === 501) {
        toast('Single deletion is not yet supported. Use Delete All instead.', 'info');
      } else {
        toast(
          err instanceof ApiError ? err.message : 'Failed to delete knowledge',
          'error',
        );
      }
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleDeleteAll() {
    setDeletingAll(true);
    try {
      await deleteAllKnowledge(botId);
      toast('All knowledge deleted', 'success');
      setDeleteAllOpen(false);
      await load();
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to delete knowledge', 'error');
    } finally {
      setDeletingAll(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size="lg" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground flex items-center justify-between gap-4">
        {loadError}
        <Button variant="secondary" size="sm" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'} taught directly to the
          bot.
        </p>
        {canManage && (
          <div className="flex items-center gap-2">
            {entries.length > 0 && (
              <Button variant="danger" size="sm" onClick={() => setDeleteAllOpen(true)}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete All
              </Button>
            )}
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              Add Knowledge
            </Button>
          </div>
        )}
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No FAQ entries yet"
          description="Add questions and answers to teach the AI how to respond to customers."
          action={
            canManage ? (
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5" />
                Add Knowledge
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => (
            <Card key={entry.id}>
              <CardBody>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <h3 className="text-sm font-semibold text-foreground">
                        {entry.question}
                      </h3>
                      {entry.category && <Badge variant="default">{entry.category}</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                      {entry.answer}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2"
                        aria-label={`Edit ${entry.question}`}
                        onClick={() => openEdit(entry)}
                      >
                        <Edit className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                        aria-label={`Delete ${entry.question}`}
                        onClick={() => setPendingDelete(entry)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={createOpen}
        onClose={() => onCreateOpenChange(false)}
        title={editingId ? 'Edit Knowledge' : 'Add Knowledge'}
        maxWidth="max-w-xl"
      >
        <form onSubmit={handleSave} className="space-y-4">
          {!editingId && (
            <div className="rounded-lg bg-[var(--blue-50)] dark:bg-[color-mix(in_srgb,var(--blue-500)_15%,transparent)] px-3 py-2 text-sm text-[var(--blue-600)] dark:text-[var(--blue-400)] mb-2 flex items-start gap-2">
              <BookOpen className="h-4 w-4 mt-0.5 shrink-0" />
              <p>
                New knowledge is automatically processed by the AI system and added to the RAG
                vector database.
              </p>
            </div>
          )}

          {formError && (
            <div className="rounded-lg bg-[var(--red-50)] dark:bg-[color-mix(in_srgb,var(--red-600)_10%,transparent)] border border-[var(--red-500)]/20 px-3 py-2 text-sm text-[var(--red-600)] dark:text-[var(--red-500)]">
              {formError}
            </div>
          )}

          <Input
            id="k-question"
            label="Question / Topic (Required)"
            placeholder="e.g. How do I reset my password?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            required
            autoFocus
          />
          <Textarea
            id="k-answer"
            label="Answer (Required)"
            placeholder="Provide the detailed answer here..."
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            required
            className="min-h-[120px]"
          />
          {/* Stacks below `sm`, like every other two-column form in the dashboard: two
              labelled inputs side by side are unusable on a phone, where each would get
              about 150px and the placeholder text is longer than that. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              id="k-title"
              label="Internal Title (Optional)"
              placeholder="e.g. Password Reset"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Input
              id="k-category"
              label="Category (Optional)"
              placeholder="e.g. Account Management"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onCreateOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              {editingId ? 'Save Changes' : 'Add to Knowledge Base'}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete Knowledge Entry"
        confirmLabel="Delete Entry"
        loading={deleting}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDelete}
        description={
          <>
            <p>
              <span className="text-foreground font-medium">{pendingDelete?.question}</span> will
              be removed from the database and the vector store. The bot will no longer answer
              from it.
            </p>
            <p className="font-medium text-destructive">This action cannot be undone.</p>
          </>
        }
      />

      <ConfirmDialog
        open={deleteAllOpen}
        title="Delete All Knowledge"
        confirmLabel="Delete All Knowledge"
        loading={deletingAll}
        onClose={() => setDeleteAllOpen(false)}
        onConfirm={handleDeleteAll}
        description={
          <>
            <p>
              Are you sure you want to delete <strong>ALL</strong> knowledge entries for{' '}
              {botName}?
            </p>
            {/*
              The wording is deliberate and matches what the server actually does.
              `deleteAllKnowledge` is scoped to the FAQ entries' own ids, so it removes
              their vectors and only theirs — `deleteBotKnowledge` would have taken the
              uploaded documents' vectors too, leaving those documents listed but no longer
              searchable. Saying so here is the difference between a warning and a scare.
            */}
            <p>
              This removes every FAQ entry, along with the searchable text they were turned
              into. Uploaded documents are not affected and stay searchable.
            </p>
            <p className="font-medium text-destructive">This action cannot be undone.</p>
          </>
        }
      />
    </div>
  );
}
