'use client';

import { Inbox, UserCheck, Layers, CheckCircle2, Bot, Filter } from 'lucide-react';
import type { QueueView } from '@/lib/api/conversations';
import type { Bot as BotType } from '@/lib/api/bots';

interface QueueSidebarProps {
  currentView: QueueView;
  onViewChange: (view: QueueView) => void;
  counts: Record<QueueView, number>;
  bots: BotType[];
  selectedBotId?: string;
  onBotChange: (botId: string | undefined) => void;
}

export function QueueSidebar({
  currentView,
  onViewChange,
  counts,
  bots,
  selectedBotId,
  onBotChange,
}: QueueSidebarProps) {
  const tabs: { id: QueueView; label: string; icon: typeof Inbox; description: string }[] = [
    {
      id: 'unassigned',
      label: 'Unassigned',
      icon: Inbox,
      description: 'Needs an agent',
    },
    {
      id: 'assigned',
      label: 'My Assigned',
      icon: UserCheck,
      description: 'Claimed by you',
    },
    {
      id: 'all_active',
      label: 'All Active',
      icon: Layers,
      description: 'Waiting or in progress',
    },
    {
      id: 'resolved',
      label: 'Resolved',
      icon: CheckCircle2,
      description: 'Closed tickets',
    },
  ];

  return (
    <div className="flex flex-col h-full space-y-4">
      <div className="space-y-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-2">
          Queues
        </h2>
        <div className="space-y-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = currentView === tab.id;
            const count = counts[tab.id];

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onViewChange(tab.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition-colors cursor-pointer select-none group ${
                  active
                    ? 'bg-accent text-accent-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-accent-foreground' : 'text-muted-foreground group-hover:text-foreground'}`} />
                  <span className="truncate">{tab.label}</span>
                </div>
                {count > 0 && (
                  <span
                    className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                      active
                        ? 'bg-accent-foreground/20 text-accent-foreground'
                        : tab.id === 'unassigned'
                        ? 'bg-destructive/15 text-destructive'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {bots.length > 0 && (
        <div className="pt-2 border-t border-border space-y-2">
          <div className="flex items-center justify-between px-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
              <Filter className="h-3 w-3" />
              Filter by Bot
            </span>
            {selectedBotId && (
              <button
                type="button"
                onClick={() => onBotChange(undefined)}
                className="text-[11px] text-accent hover:underline cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>

          <div className="space-y-1">
            <button
              type="button"
              onClick={() => onBotChange(undefined)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors cursor-pointer text-left ${
                !selectedBotId
                  ? 'bg-muted text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
              }`}
            >
              <Bot className="h-3.5 w-3.5 text-muted-foreground" />
              All Bots
            </button>
            {bots.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => onBotChange(b.id)}
                className={`w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-xs transition-colors cursor-pointer text-left ${
                  selectedBotId === b.id
                    ? 'bg-muted text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                }`}
              >
                <div className="flex items-center gap-2 truncate">
                  <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="truncate">{b.name}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
