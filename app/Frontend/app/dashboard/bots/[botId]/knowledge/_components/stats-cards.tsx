'use client';

import { CheckCircle2, CircleSlash, Layers, Package } from 'lucide-react';
import type { ChunkStats } from '@/lib/api/knowledgeChunks';

interface StatsCardsProps {
  stats: ChunkStats | null;
  loading: boolean;
}

/**
 * The four counts at the top of the knowledge page (section 15.2).
 *
 * A skeleton is shown while they load rather than zeros. "0 chunks" is a meaningful claim —
 * it says the bot knows nothing — and rendering it during the first request would state
 * something false for as long as the request takes.
 */
export function StatsCards({ stats, loading }: StatsCardsProps) {
  const cards = [
    { key: 'total', label: 'Total Chunks', value: stats?.totalChunks, icon: Layers },
    { key: 'enabled', label: 'Enabled', value: stats?.enabledChunks, icon: CheckCircle2 },
    { key: 'disabled', label: 'Disabled', value: stats?.disabledChunks, icon: CircleSlash },
    { key: 'sources', label: 'Documents', value: stats?.totalSources, icon: Package },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
      {cards.map((card) => (
        <div key={card.key} className="rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex items-center gap-2 text-muted-foreground">
            <card.icon className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{card.label}</span>
          </div>
          {loading ? (
            <div className="mt-2 h-6 w-12 rounded bg-muted animate-pulse" />
          ) : (
            <p className="mt-1 text-xl font-semibold text-foreground tabular-nums">
              {card.value ?? 0}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
