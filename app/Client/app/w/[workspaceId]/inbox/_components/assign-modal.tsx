'use client';

import { useState, useEffect } from 'react';
import { Check, AlertCircle } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { listWorkspaceMembers, type WorkspaceMemberInfo } from '@/lib/api/workspaces';
import { assignConversation, type Conversation } from '@/lib/api/conversations';
import { ApiError } from '@/lib/api-client';

interface AssignModalProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  conversationId: string;
  currentAgentId?: string | null;
  onAssigned: (updated: Conversation) => void;
}

function initialOf(value: string) {
  return value.trim().charAt(0).toUpperCase() || '?';
}

export function AssignModal({
  open,
  onClose,
  workspaceId,
  conversationId,
  currentAgentId,
  onAssigned,
}: AssignModalProps) {
  const [members, setMembers] = useState<WorkspaceMemberInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !workspaceId) return;

    let cancelled = false;

    async function loadMembers() {
      setLoading(true);
      setError('');
      try {
        const list = await listWorkspaceMembers(workspaceId);
        if (cancelled) return;
        setMembers(list);
        if (currentAgentId) {
          setSelectedAgentId(currentAgentId);
        } else if (list.length > 0) {
          setSelectedAgentId(list[0].userId);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to load workspace members');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadMembers();

    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, currentAgentId]);

  async function handleAssign() {
    if (!selectedAgentId || submitting) return;

    setSubmitting(true);
    setError('');
    try {
      const updated = await assignConversation(conversationId, selectedAgentId);
      onAssigned(updated);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to assign conversation');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Assign conversation" maxWidth="max-w-md">
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Choose an agent or administrator in this workspace to handle the ticket.
        </p>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-error-bg-foreground/20 bg-error-bg p-3 text-xs text-error-bg-foreground">
            <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner size="md" />
          </div>
        ) : members.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No workspace members found.
          </p>
        ) : (
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {members.map((member) => {
              const isSelected = selectedAgentId === member.userId;
              const isCurrent = currentAgentId === member.userId;

              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => setSelectedAgentId(member.userId)}
                  aria-pressed={isSelected}
                  className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                    isSelected
                      ? 'border-accent/50 bg-accent/5'
                      : 'border-transparent hover:border-border hover:bg-muted/40'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground">
                      {initialOf(member.user.name)}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-foreground">
                        {member.user.name}
                        {isCurrent && (
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                            You
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {member.user.email} · {member.role}
                      </p>
                    </div>
                  </div>

                  {isSelected && (
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
                      <Check aria-hidden="true" className="h-3 w-3" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleAssign}
            loading={submitting}
            disabled={!selectedAgentId || submitting || loading}
          >
            Confirm assignment
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
