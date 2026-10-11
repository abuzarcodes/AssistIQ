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
  User,
  Headphones,
  Info,
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
}

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
    <div className="flex flex-col flex-1 h-full min-w-0 bg-background overflow-hidden">
      {/* Header bar */}
      <div className="px-5 py-3.5 border-b border-border bg-card flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-8 w-8 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
            <User className="h-4 w-4 text-accent" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground truncate">
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
                {conversation.status}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
              {conversation.bot && <span>Bot: {conversation.bot.name}</span>}
              {conversation.assignedAgent && (
                <>
                  <span>•</span>
                  <span className="flex items-center gap-1 text-accent font-medium">
                    <Headphones className="h-3 w-3" />
                    {isAssignedToMe ? 'Assigned to you' : conversation.assignedAgent.name}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {isWaiting && (
            <Button
              size="sm"
              variant="primary"
              loading={actionLoading}
              onClick={onClaim}
            >
              <UserCheck className="h-3.5 w-3.5 mr-1" />
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
              <UserX className="h-3.5 w-3.5 mr-1 text-muted-foreground" />
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
              <UserPlus className="h-3.5 w-3.5 mr-1" />
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
              <CheckCircle2 className="h-3.5 w-3.5 mr-1 text-success" />
              Resolve
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={actionLoading}
              onClick={onReopen}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              Reopen
            </Button>
          )}
        </div>
      </div>

      {/* Escalation/Status Banner */}
      {isWaiting && (
        <div className="px-4 py-2 bg-[var(--amber-50)] dark:bg-[color-mix(in_srgb,var(--amber-500)_15%,transparent)] border-b border-[var(--amber-500)]/30 text-xs text-[var(--amber-500)] dark:text-[var(--amber-400)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              Customer is waiting for support. Reason:{' '}
              <strong className="font-semibold">
                {conversation.escalationReason || 'Human requested'}
              </strong>
            </span>
          </div>
          <button
            type="button"
            onClick={onClaim}
            className="font-semibold underline cursor-pointer hover:opacity-80"
          >
            Claim now
          </button>
        </div>
      )}

      {/* Transcript Messages Thread */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-2">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mb-3">
              <Bot className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">No messages in transcript</p>
            <p className="text-xs text-muted-foreground mt-1">
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
