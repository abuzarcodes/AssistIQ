'use client';

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Send, CornerDownLeft, Loader2, UserCheck, RotateCcw } from 'lucide-react';
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
      <div className="p-4 border-t border-border bg-muted/40 flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
        <div>
          <p className="text-xs font-medium text-foreground">Conversation is resolved</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Customer inquiry was marked complete. Reopen to send further agent messages.
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
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            Reopen Ticket
          </Button>
        )}
      </div>
    );
  }

  if (status === 'WAITING_FOR_HUMAN') {
    return (
      <div className="p-4 border-t border-border bg-accent/5 flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
        <div>
          <p className="text-xs font-medium text-foreground">Waiting for an agent</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Claim this conversation to handle the inquiry and reply directly to the customer.
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
            <UserCheck className="h-3.5 w-3.5 mr-1" />
            Claim Ticket
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="p-3 border-t border-border bg-card">
      <div className="relative rounded-xl border border-border bg-background focus-within:border-accent focus-within:ring-1 focus-within:ring-accent transition-all">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || sending}
          placeholder="Reply as support agent... (Press Ctrl+Enter to send)"
          rows={3}
          className="w-full resize-none bg-transparent px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden disabled:opacity-50"
        />

        <div className="flex items-center justify-between px-3 py-2 border-t border-border/60 bg-muted/20">
          <span className="text-[11px] text-muted-foreground flex items-center gap-1">
            <CornerDownLeft className="h-3 w-3" />
            <span>Cmd/Ctrl + Enter to send</span>
          </span>

          <Button
            size="sm"
            onClick={handleSend}
            disabled={!content.trim() || disabled || sending}
            loading={sending}
            className="h-7 px-3 text-xs"
          >
            <Send className="h-3 w-3 mr-1" />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
