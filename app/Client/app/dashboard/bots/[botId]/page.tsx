'use client';

import { useEffect } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { getBot } from '@/lib/api/bots';

/**
 * Legacy bot-detail bridge.
 *
 * The workspace routes now own both the overview and the configuration surface.
 * A plain visit resolves the bot's workspace and opens the overview; the old
 * `?legacy=configure` link resolves to the workspace `/configure` page. Nothing
 * is rendered here, so there is only one configuration surface to maintain.
 */
export default function BotDetailPage() {
  const params = useParams<{ botId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();

  const legacyConfigure = searchParams.get('legacy') === 'configure';

  useEffect(() => {
    let cancelled = false;

    getBot(params.botId)
      .then((bot) => {
        if (cancelled) return;

        const base = `/w/${bot.workspaceId}/bots/${bot.id}`;
        router.replace(legacyConfigure ? `${base}/configure` : base);
      })
      .catch(() => {
        if (cancelled) return;
        toast('Failed to load bot', 'error');
        router.replace('/home');
      });

    return () => {
      cancelled = true;
    };
  }, [legacyConfigure, params.botId, router, toast]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center py-20"
    >
      <Spinner size="lg" />
      <span className="sr-only">
        {legacyConfigure ? 'Opening bot configuration…' : 'Opening bot…'}
      </span>
    </div>
  );
}
