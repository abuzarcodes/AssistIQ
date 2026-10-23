'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { getBot } from '@/lib/api/bots';

interface LegacyBotRedirectProps {
  /** Appended to the workspace-scoped bot path, e.g. `/knowledge`. */
  suffix: string;
  /** Announced while the bot and its workspace are resolved. */
  label: string;
}

/**
 * A legacy bot URL has no workspace id in it, so the destination cannot be written as a
 * static redirect. This bridge resolves the bot once, then replaces the history entry with
 * its workspace-scoped route. It is shared by the knowledge, source and conversation
 * bookmarks left behind by the route move.
 */
export function LegacyBotRedirect({ suffix, label }: LegacyBotRedirectProps) {
  const params = useParams<{ botId: string }>();
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;

    getBot(params.botId)
      .then((bot) => {
        if (cancelled) return;
        router.replace(`/w/${bot.workspaceId}/bots/${bot.id}${suffix}`);
      })
      .catch(() => {
        if (cancelled) return;
        toast('Failed to load bot', 'error');
        router.replace('/home');
      });

    return () => {
      cancelled = true;
    };
  }, [params.botId, router, suffix, toast]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center py-20"
    >
      <Spinner size="lg" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
