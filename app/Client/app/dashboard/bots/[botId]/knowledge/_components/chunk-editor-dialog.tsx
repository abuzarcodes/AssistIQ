'use client';

import { useState } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import { updateChunk, type KnowledgeChunk } from '@/lib/api/knowledgeChunks';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';

interface ChunkEditorDialogProps {
  chunk: KnowledgeChunk;
  onClose: () => void;
  onSaved: (chunk: KnowledgeChunk) => void;
}

/**
 * Edit one chunk's text (section 15.5).
 *
 * Saving re-embeds through the AI service, which is a real round trip and can fail on its
 * own. The button says so while it runs — "Re-embedding…", not "Saving…" — because the
 * wait is longer than a row update and the user should know what the time is going into.
 *
 * A save that leaves the text unchanged does not call the server at all. The API skips the
 * re-embed in that case too (an identical string cannot produce a different vector), so
 * sending it would be a request whose only effect is a version bump and a fresh timestamp.
 *
 * The chunk arrives as a required prop. The caller mounts this only while a chunk is being
 * edited, keyed by its id, so the textarea's initial state *is* that chunk's text and there
 * is nothing to keep in sync afterwards.
 */
export function ChunkEditorDialog({ chunk, onClose, onSaved }: ChunkEditorDialogProps) {
  const { toast } = useToast();

  const [content, setContent] = useState(chunk.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const changed = content !== chunk.content;
  const empty = content.trim().length === 0;

  async function handleSave() {
    if (!changed) {
      onClose();
      return;
    }

    setSaving(true);
    setError('');

    try {
      const updated = await updateChunk(chunk.id, { content });
      toast('Chunk updated and re-embedded', 'success');
      onSaved(updated);
      onClose();
    } catch (err) {
      // Left open on purpose. The failure is recoverable by retrying from here, and
      // closing the dialog would throw away the edited text the user would have to
      // retype — the server keeps the previous content, so nothing is half-applied.
      setError(
        err instanceof ApiError
          ? err.message
          : 'The chunk could not be saved. The embedding service did not respond.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={saving ? () => {} : onClose}
      title="Edit Chunk"
      maxWidth="max-w-2xl"
    >
      <div className="space-y-4">
        {/* Provenance. Read-only because it is not editable: the page and index come from
            the document's own structure, and letting them be retyped would let the row
            claim a position the document does not have. */}
        <div className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
          <div className="flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="text-foreground font-medium truncate">{chunk.source.filename}</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            <span>Chunk #{chunk.chunkIndex + 1}</span>
            {chunk.pageNumber !== null && <span>Page {chunk.pageNumber}</span>}
            {chunk.section && <span>Section: {chunk.section}</span>}
            <span>Version {chunk.version}</span>
            <span>{chunk.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
        </div>

        {error && (
          <div className="rounded-lg bg-[var(--red-50)] dark:bg-[color-mix(in_srgb,var(--red-600)_10%,transparent)] border border-[var(--red-500)]/20 px-3 py-2 text-sm text-[var(--red-600)] dark:text-[var(--red-500)]">
            {error}
          </div>
        )}

        <Textarea
          id="chunk-content"
          label="Chunk Content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="min-h-[200px] font-mono text-xs"
          disabled={saving}
          autoFocus
        />

        {/* Only when it applies. A warning shown on a no-op save teaches people to ignore
            it, and the server skips the re-embed in exactly this case. */}
        {changed && !empty && (
          <div className="rounded-lg bg-[var(--amber-50)] dark:bg-[color-mix(in_srgb,var(--amber-500)_15%,transparent)] px-3 py-2 text-sm text-[var(--amber-500)] flex items-start gap-2">
            <Sparkles className="h-4 w-4 mt-0.5 shrink-0" />
            <p>
              Saving will regenerate the AI embedding for this chunk. Until it finishes, the
              previous version stays searchable.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={saving}
            disabled={empty || !changed}
            onClick={handleSave}
          >
            {saving ? 'Re-embedding…' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
