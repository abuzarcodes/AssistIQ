'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bot, Clock, Headphones } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { QueueItem } from '@/lib/api/conversations';

interface ConversationCardProps {
  item: QueueItem;
  selected?: boolean;
  onClick?: () => void;
}

export function ConversationCard({ item, selected, onClick }: ConversationCardProps) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // The wait badge is a relative clock: update on mount and once a minute.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  const waitingDuration = useMemo(() => {
    if (now == null || item.status === 'RESOLVED') return null;
    const timeRef = item.escalatedAt
      ? new Date(item.escalatedAt).getTime()
      : new Date(item.createdAt).getTime();
    const minutes = Math.floor((now - timeRef) / (1000 * 60));

    if (minutes < 5) return { label: '< 5m', variant: 'success' as const };
    if (minutes <= 15) return { label: '5-15m', variant: 'warning' as const };
    return { label: '> 15m', variant: 'danger' as const };
  }, [item.escalatedAt, item.createdAt, item.status, now]);

  const lastMessage = item.messages?.[0] ?? null;

  const statusBadge = useMemo(() => {
    switch (item.status) {
      case 'WAITING_FOR_HUMAN':
        return (
          <Badge variant="warning" dot>
            Waiting
          </Badge>
        );
      case 'HUMAN_ACTIVE':
        return (
          <Badge variant="info" dot>
            Handling
          </Badge>
        );
      case 'RESOLVED':
        return <Badge variant="success">Resolved</Badge>;
      case 'ACTIVE':
        return <Badge variant="default">Bot</Badge>;
      default:
        return <Badge variant="default">{item.status}</Badge>;
    }
  }, [item.status]);

  const reasonLabel = useMemo(() => {
    if (!item.escalationReason) return null;
    const clean = item.escalationReason.replace(/_/g, ' ').toLowerCase();
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }, [item.escalationReason]);

  const displayTime = useMemo(
    () =>
      new Date(item.updatedAt || item.createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    [item.updatedAt, item.createdAt],
  );

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full cursor-pointer rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        selected
          ? 'border-accent/50 bg-accent/5'
          : 'border-transparent hover:border-border hover:bg-muted/40'
      }`}
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          Visitor #{item.id.slice(0, 6)}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {waitingDuration && (
            <Badge
              variant={waitingDuration.variant}
              className="px-1.5 py-0 text-[11px]"
            >
              <Clock aria-hidden="true" className="mr-0.5 inline h-2.5 w-2.5" />
              {waitingDuration.label}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">{displayTime}</span>
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {statusBadge}
        {item.bot && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Bot aria-hidden="true" className="h-3 w-3" />
            {item.bot.name}
          </span>
        )}
        {item.assignedAgent && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-accent-strong">
            <Headphones aria-hidden="true" className="h-3 w-3" />
            {item.assignedAgent.name}
          </span>
        )}
        {reasonLabel && (
          <span className="text-xs text-muted-foreground">{reasonLabel}</span>
        )}
      </div>

      <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
        {lastMessage ? (
          <>
            <span className="font-medium text-foreground">
              {lastMessage.role === 'USER'
                ? 'Customer: '
                : lastMessage.role === 'AGENT'
                  ? 'Agent: '
                  : lastMessage.role === 'SYSTEM'
                    ? 'System: '
                    : 'Bot: '}
            </span>
            {lastMessage.content}
          </>
        ) : (
          <span className="italic">No messages yet</span>
        )}
      </p>
    </button>
  );
}
