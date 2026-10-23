'use client';

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Send, CornerDownLeft, UserCheck, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface AgentComposerProps {
  onSend: (content: string) => Promise<void>;
  disabled?: boolean;
  status?: string;
  isAssignedToCurrentUser?: boolean;
  onClaim?: () => Promise<void>;
  onReopen?: () => Promise<void>;
}

export function AgentComposer({
  onSend,
  disabled,
  status,
  isAssignedToCurrentUser,
  onClaim,
  onReopen,
}: AgentComposerProps) {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (status === 'HUMAN_ACTIVE' && isAssignedToCurrentUser) {
      textareaRef.current?.focus();
    }
  }, [status, isAssignedToCurrentUser]);

  async function handleSend() {
    const trimmed = content.trim();
    if (!trimmed || sending || disabled) return;

    setSending(true);
    try {
      await onSend(trimmed);
      setContent('');
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSend();
    }
  }

  async function handleClaimClick() {
    if (!onClaim || actionLoading) return;
    setActionLoading(true);
    try {
      await onClaim();
    } finally {
      setActionLoading(false);
    }
  }

  async function handleReopenClick() {
    if (!onReopen || actionLoading) return;
    setActionLoading(true);
    try {
      await onReopen();
    } finally {
      setActionLoading(false);
    }
  }

  if (status === 'RESOLVED') {
    return (
      <div className="flex flex-col items-center justify-between gap-3 border-t border-border bg-muted/40 p-4 text-center sm:flex-row sm:text-left">
        <div>
          <p className="text-xs font-medium text-foreground">Conversation is resolved</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Reopen the ticket to send further agent messages.
          </p>
        </div>
        {onReopen && (
          <Button
            size="sm"
            variant="secondary"
            loading={actionLoading}
            onClick={handleReopenClick}
            className="shrink-0"
          >
            <RotateCcw aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Reopen ticket
          </Button>
        )}
      </div>
    );
  }

  if (status === 'WAITING_FOR_HUMAN') {
    return (
      <div className="flex flex-col items-center justify-between gap-3 border-t border-border bg-accent/5 p-4 text-center sm:flex-row sm:text-left">
        <div>
          <p className="text-xs font-medium text-foreground">Waiting for an agent</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Claim this conversation to reply directly to the customer.
          </p>
        </div>
        {onClaim && (
          <Button
            size="sm"
            variant="primary"
            loading={actionLoading}
            onClick={handleClaimClick}
            className="shrink-0"
          >
            <UserCheck aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            Claim ticket
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-card p-3">
      <div className="rounded-lg border border-border bg-background transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || sending}
          placeholder="Write a reply to the customer..."
          rows={2}
          className="w-full resize-none bg-transparent px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden disabled:opacity-50"
        />

        <div className="flex items-center justify-between border-t border-border/60 px-3 py-1.5">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <CornerDownLeft aria-hidden="true" className="h-3 w-3" />
            Ctrl + Enter to send
          </span>

          <Button
            size="sm"
            onClick={handleSend}
            disabled={!content.trim() || disabled || sending}
            loading={sending}
            className="h-7 px-3 text-xs"
          >
            <Send aria-hidden="true" className="mr-1 h-3 w-3" />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
