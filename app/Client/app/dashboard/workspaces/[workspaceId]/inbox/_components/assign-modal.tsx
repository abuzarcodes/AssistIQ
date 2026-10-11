'use client';

import { useState, useEffect } from 'react';
import { User, Check, AlertCircle } from 'lucide-react';
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
    if (open && workspaceId) {
      loadMembers();
    }
  }, [open, workspaceId]);

  async function loadMembers() {
    setLoading(true);
    setError('');
    try {
      const list = await listWorkspaceMembers(workspaceId);
      setMembers(list);
      if (currentAgentId) {
        setSelectedAgentId(currentAgentId);
      } else if (list.length > 0) {
        setSelectedAgentId(list[0].userId);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load workspace members');
    } finally {
      setLoading(false);
    }
  }

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
    <Dialog open={open} onClose={onClose} title="Assign Conversation" maxWidth="max-w-md">
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Select an agent or administrator in this workspace to handle this ticket.
        </p>

        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-xs text-destructive flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner size="md" />
          </div>
        ) : members.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            No workspace members found.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
            {members.map((member) => {
              const isSelected = selectedAgentId === member.userId;
              const isCurrent = currentAgentId === member.userId;

              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => setSelectedAgentId(member.userId)}
                  className={`w-full flex items-center justify-between p-2.5 rounded-xl border text-left transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-accent bg-accent/5'
                      : 'border-border hover:bg-muted/60'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="truncate">
                      <p className="text-xs font-semibold text-foreground truncate">
                        {member.user.name}
                        {isCurrent && (
                          <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">
                            (Current)
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {member.user.email} • {member.role}
                      </p>
                    </div>
                  </div>

                  {isSelected && (
                    <div className="h-5 w-5 rounded-full bg-accent text-accent-foreground flex items-center justify-center shrink-0">
                      <Check className="h-3 w-3" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleAssign}
            loading={submitting}
            disabled={!selectedAgentId || submitting || loading}
          >
            Confirm Assignment
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
