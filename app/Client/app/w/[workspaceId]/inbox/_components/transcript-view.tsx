'use client';

import { useEffect, useRef } from 'react';
import {
  UserCheck,
  UserX,
  UserPlus,
  CheckCircle2,
  RotateCcw,
  AlertTriangle,
  Bot,
  Headphones,
  ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChatBubble } from './chat-bubble';
import type { Conversation, Message } from '@/lib/api/conversations';

interface TranscriptViewProps {
  conversation: Conversation;
  messages: Message[];
  currentUserId?: string;
  isOwnerOrAdmin?: boolean;
  onClaim: () => Promise<void>;
  onUnassign: () => Promise<void>;
  onResolve: () => Promise<void>;
  onReopen: () => Promise<void>;
  onOpenAssignModal: () => void;
  actionLoading?: boolean;
  onBack?: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Bot active',
  WAITING_FOR_HUMAN: 'Waiting for human',
  HUMAN_ACTIVE: 'Human active',
  RESOLVED: 'Resolved',
};

export function TranscriptView({
  conversation,
  messages,
  currentUserId,
  isOwnerOrAdmin,
  onClaim,
  onUnassign,
  onResolve,
  onReopen,
  onOpenAssignModal,
  actionLoading,
  onBack,
}: TranscriptViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages.length]);

  const isAssignedToMe = conversation.assignedAgentId === currentUserId;
  const isClaimed = Boolean(conversation.assignedAgentId);
  const isWaiting = conversation.status === 'WAITING_FOR_HUMAN';
  const isHumanActive = conversation.status === 'HUMAN_ACTIVE';
  const isResolved = conversation.status === 'RESOLVED';

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 md:hidden"
            >
              <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              All
            </button>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold text-foreground">
                {conversation.contact?.name || `Visitor #${conversation.id.slice(0, 8)}`}
              </h2>
              <Badge
                variant={
                  isWaiting
                    ? 'warning'
                    : isHumanActive
                      ? 'info'
                      : isResolved
                        ? 'success'
                        : 'default'
                }
                dot={isWaiting || isHumanActive}
              >
                {STATUS_LABELS[conversation.status] ?? conversation.status}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {conversation.bot && <span>{conversation.bot.name}</span>}
              {conversation.assignedAgent && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 font-medium text-accent-strong">
                    <Headphones aria-hidden="true" className="h-3 w-3" />
                    {isAssignedToMe ? 'Assigned to you' : conversation.assignedAgent.name}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isWaiting && (
            <Button
              size="sm"
              variant="primary"
              loading={actionLoading}
              onClick={onClaim}
            >
              <UserCheck aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Claim
            </Button>
          )}

          {isHumanActive && isAssignedToMe && (
            <Button
              size="sm"
              variant="ghost"
              loading={actionLoading}
              onClick={onUnassign}
              title="Return ticket to the queue"
            >
              <UserX aria-hidden="true" className="mr-1 h-3.5 w-3.5 text-muted-foreground" />
              Unassign
            </Button>
          )}

          {isOwnerOrAdmin && !isResolved && (
            <Button
              size="sm"
              variant="secondary"
              disabled={actionLoading}
              onClick={onOpenAssignModal}
            >
              <UserPlus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              {isClaimed ? 'Reassign' : 'Assign'}
            </Button>
          )}

          {!isResolved ? (
            <Button
              size="sm"
              variant="secondary"
              loading={actionLoading}
              onClick={onResolve}
            >
              <CheckCircle2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 text-success" />
              Resolve
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={actionLoading}
              onClick={onReopen}
            >
              <RotateCcw aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Reopen
            </Button>
          )}
        </div>
      </div>

      {isWaiting && (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning-bg-foreground/30 bg-warning-bg px-4 py-2 text-xs text-warning-bg-foreground">
          <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>
            Customer is waiting for support. Reason:{' '}
            <strong className="font-semibold">
              {conversation.escalationReason || 'Human requested'}
            </strong>
          </span>
        </div>
      )}

      <div
        role="log"
        aria-label="Conversation transcript"
        className="flex-1 space-y-2 overflow-y-auto p-4 sm:p-5"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center py-12 text-center">
            <Bot aria-hidden="true" className="mb-3 h-7 w-7 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No messages in transcript</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Start by typing a message below or wait for customer activity.
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <ChatBubble
              key={message.id || message.clientMessageId || `${message.createdAt}-${message.role}`}
              message={message}
              agentName={
                message.senderId === currentUserId
                  ? 'You'
                  : conversation.assignedAgent?.name
              }
              isCurrentUser={message.senderId === currentUserId}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
