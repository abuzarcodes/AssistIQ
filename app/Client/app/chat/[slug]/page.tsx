'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { MessageSquareOff } from 'lucide-react';
import { CustomerChatWidget } from '@/components/widget/CustomerChatWidget';
import {
  useExperienceTone,
  experienceChatColors,
} from '@/components/widget/experience-theme';
import {
  getPublishedConfigBySlug,
  getPublishedConfigByDeploymentId,
  PublicApiError,
  type PublishedDeploymentPayload,
} from '@/lib/api/publicChat';

/**
 * The hosted public chat page (CP-11.1, CP-11.2).
 *
 * Served at `/chat/:slug` — the URL the deployment snippet hands out. It reads the
 * **published** snapshot, never the draft: what the owner previewed in the studio
 * only reaches this page through Publish. A slug that resolves to nothing (never
 * published, unpublished or disabled since) gets an honest unavailable state
 * instead of a broken chat.
 *
 * Slugs are the primary key, but older hosted URLs carry the deployment id, so a
 * slug miss falls back to a direct deployment lookup before giving up.
 */
export default function HostedChatPage() {
  const params = useParams<{ slug: string }>();
  const slug = Array.isArray(params?.slug) ? params.slug[0] : params?.slug;

  const [payload, setPayload] = useState<PublishedDeploymentPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  // The body of this callback performs no synchronous state writes — every
  // setState happens in a promise continuation — so calling it from the mount
  // effect below stays clear of the set-state-in-effect rule, the same way the
  // studio's own loader does.
  const load = useCallback(() => {
    if (!slug) return;
    const request = ++requestRef.current;

    getPublishedConfigBySlug(slug).then(
      (result) => {
        if (request !== requestRef.current) return;
        setPayload(result);
        setError(null);
      },
      (slugError: unknown) => {
        if (request !== requestRef.current) return;
        if (
          slugError instanceof PublicApiError &&
          slugError.status === 404
        ) {
          getPublishedConfigByDeploymentId(slug).then(
            (result) => {
              if (request !== requestRef.current) return;
              setPayload(result);
              setError(null);
            },
            (idError: unknown) => {
              if (request !== requestRef.current) return;
              setPayload(null);
              setError(
                idError instanceof PublicApiError &&
                  idError.status === 404
                  ? 'This chat link is unavailable. It may never have been published, or it was unpublished or disabled since.'
                  : idError instanceof PublicApiError
                    ? idError.message
                    : 'We could not load this chat. Check your connection and try again.',
              );
            },
          );
          return;
        }
        setPayload(null);
        setError(
          slugError instanceof PublicApiError
            ? slugError.message
            : 'We could not load this chat. Check your connection and try again.',
        );
      },
    );
  }, [slug]);

  useEffect(() => {
    load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  if (!slug) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <p className="text-sm text-muted-foreground">Loading chat…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <div
          role="alert"
          className="flex max-w-sm flex-col items-center gap-2 rounded-2xl border border-border bg-card px-6 py-8 text-center"
        >
          <MessageSquareOff
            aria-hidden="true"
            className="h-8 w-8 text-muted-foreground"
          />
          <p className="text-sm font-semibold text-foreground">
            This chat is unavailable
          </p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 cursor-pointer rounded-lg bg-muted px-4 py-2 text-xs font-medium text-foreground transition-colors hover:opacity-80"
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  if (!payload) {
    return (
      <main
        className="flex min-h-screen items-center justify-center bg-background p-4"
        role="status"
        aria-live="polite"
        aria-label="Loading chat"
      >
        <div aria-hidden="true" className="flex w-full max-w-2xl flex-col gap-3">
          <span className="mx-auto block h-6 w-48 animate-pulse rounded bg-muted" />
          <span className="block h-[480px] w-full animate-pulse rounded-2xl bg-muted" />
        </div>
      </main>
    );
  }

  return <HostedChat payload={payload} />;
}

/** The loaded page, themed from the published snapshot (CP-11.4). */
function HostedChat({ payload }: { payload: PublishedDeploymentPayload }) {
  const { config } = payload;
  const tone = useExperienceTone(config.themeMode);
  const colors = experienceChatColors(config, tone);
  const title = config.hostedPageTitle || config.displayName || payload.bot.name;
  const name = config.displayName || payload.bot.name;

  useEffect(() => {
    document.title = `${title} · Chat`;
  }, [title]);

  return (
    <main
      className="flex min-h-screen flex-col"
      style={{ backgroundColor: colors.ground, color: colors.ink }}
    >
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 sm:py-10">
        {(config.hostedPageTitle || config.hostedPageDescription) && (
          <div className="mb-5 text-center">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              {config.hostedPageTitle || name}
            </h1>
            {config.hostedPageDescription && (
              <p
                className="mx-auto mt-2 max-w-prose text-[13px] leading-relaxed"
                style={{ color: colors.muted }}
              >
                {config.hostedPageDescription}
              </p>
            )}
          </div>
        )}

        <div className="min-h-[480px] flex-1">
          <CustomerChatWidget
            botId={payload.bot.id}
            botName={name}
            standalone
            experienceConfig={config}
            deploymentId={payload.deployment.id}
          />
        </div>
      </div>
    </main>
  );
}
