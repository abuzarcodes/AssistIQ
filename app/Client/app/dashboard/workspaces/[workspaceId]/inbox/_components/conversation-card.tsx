'use client';

import { useMemo } from 'react';
import { Bot, Clock, User, Headphones } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { QueueItem } from '@/lib/api/conversations';

interface ConversationCardProps {
  item: QueueItem;
  selected?: boolean;
  onClick?: () => void;
}

export function ConversationCard({ item, selected, onClick }: ConversationCardProps) {
  const waitingDuration = useMemo(() => {
    if (item.status === 'RESOLVED') return null;
    const timeRef = item.escalatedAt ? new Date(item.escalatedAt).getTime() : new Date(item.createdAt).getTime();
    const minutes = Math.floor((Date.now() - timeRef) / (1000 * 60));

    if (minutes < 5) {
      return { label: '< 5m', variant: 'success' as const };
    }
    if (minutes <= 15) {
      return { label: '5-15m', variant: 'warning' as const };
    }
    return { label: '> 15m', variant: 'danger' as const };
  }, [item.escalatedAt, item.createdAt, item.status]);

  const lastMessage = item.messages && item.messages.length > 0 ? item.messages[0] : null;

  const statusBadge = useMemo(() => {
    switch (item.status) {
      case 'WAITING_FOR_HUMAN':
        return <Badge variant="warning" dot>Waiting</Badge>;
      case 'HUMAN_ACTIVE':
        return <Badge variant="info" dot>Handling</Badge>;
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

  const displayTime = useMemo(() => {
    const d = new Date(item.updatedAt || item.createdAt);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [item.updatedAt, item.createdAt]);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left p-3.5 rounded-xl border transition-all cursor-pointer select-none group ${
        selected
          ? 'bg-card border-accent shadow-xs ring-1 ring-accent/30'
          : 'bg-card/60 hover:bg-card border-border hover:border-accent/40'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center shrink-0">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <span className="text-sm font-semibold text-foreground truncate">
            Visitor #{item.id.slice(0, 6)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {waitingDuration && (
            <Badge variant={waitingDuration.variant} className="text-[10px] px-1.5 py-0">
              <Clock className="h-2.5 w-2.5 mr-0.5 inline" />
              {waitingDuration.label}
            </Badge>
          )}
          <span className="text-[11px] text-muted-foreground">{displayTime}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {statusBadge}
        {item.bot && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground bg-muted px-2 py-0.5 rounded-md">
            <Bot className="h-3 w-3" />
            {item.bot.name}
          </span>
        )}
        {item.assignedAgent && (
          <span className="inline-flex items-center gap-1 text-[11px] text-accent font-medium bg-accent/10 px-2 py-0.5 rounded-md">
            <Headphones className="h-3 w-3" />
            {item.assignedAgent.name}
          </span>
        )}
        {reasonLabel && (
          <span className="text-[10px] text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded border border-border">
            {reasonLabel}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
        {lastMessage ? (
          <>
            <span className="font-medium text-foreground">
              {lastMessage.role === 'USER' ? 'Customer: ' : lastMessage.role === 'AGENT' ? 'Agent: ' : 'Bot: '}
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
