'use client';

import { Inbox, UserCheck, Layers, CheckCircle2, Bot } from 'lucide-react';
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
  const views: { id: QueueView; label: string; icon: typeof Inbox }[] = [
    { id: 'unassigned', label: 'Unassigned', icon: Inbox },
    { id: 'assigned', label: 'My assigned', icon: UserCheck },
    { id: 'all_active', label: 'All active', icon: Layers },
    { id: 'resolved', label: 'Resolved', icon: CheckCircle2 },
  ];

  return (
    <div className="flex h-full flex-col gap-5">
      <div>
        <h2 className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
          Queues
        </h2>
        <div className="space-y-0.5">
          {views.map((view) => {
            const Icon = view.icon;
            const active = currentView === view.id;

            return (
              <button
                key={view.id}
                type="button"
                onClick={() => onViewChange(view.id)}
                aria-current={active ? 'page' : undefined}
                className={`flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  active
                    ? 'bg-sidebar-active font-medium text-sidebar-active-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span className="truncate">{view.label}</span>
                </span>
                {counts[view.id] > 0 && (
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs font-medium ${
                      active
                        ? 'bg-card text-foreground'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {counts[view.id]}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {bots.length > 0 && (
        <div className="border-t border-border pt-4">
          <div className="flex items-center justify-between px-2 pb-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Bots
            </span>
            {selectedBotId && (
              <button
                type="button"
                onClick={() => onBotChange(undefined)}
                className="cursor-pointer rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                Clear
              </button>
            )}
          </div>

          <div className="space-y-0.5">
            <button
              type="button"
              onClick={() => onBotChange(undefined)}
              className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                !selectedBotId
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              }`}
            >
              <Bot aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              All bots
            </button>
            {bots.map((bot) => (
              <button
                key={bot.id}
                type="button"
                onClick={() => onBotChange(bot.id)}
                className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  selectedBotId === bot.id
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                }`}
              >
                <Bot aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate" title={bot.name}>{bot.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
