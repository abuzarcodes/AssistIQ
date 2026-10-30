'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { getBotConfig } from '@/lib/api/botConfig';
import { getBot, type Bot } from '@/lib/api/bots';
import { useWorkspace } from '@/lib/workspace-context';
import { BotAvatar } from './_components/bot-avatar';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : DATE_FORMATTER.format(date);
}

/**
 * Bot overview (CP5).
 *
 * This is a navigation surface, not a configuration surface: identity and real
 * metadata at the top, then the three places a bot is worked on. The
 * configuration tabs live on `/configure` (CP6), not here.
 */
export default function WorkspaceBotPage() {
  const { workspaceId, setPageBreadcrumbs } = useWorkspace();
  const params = useParams<{ botId: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const [bot, setBot] = useState<Bot | null>(null);
  const [avatar, setAvatar] = useState<{
    botId: string;
    hasAvatar: boolean;
    version: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const loadBot = useCallback(() => {
    const request = ++requestRef.current;

    return getBot(params.botId)
      .then((data) => {
        if (request !== requestRef.current) return;

        if (data.workspaceId !== workspaceId) {
          router.replace(`/w/${data.workspaceId}/bots/${data.id}`);
          return;
        }

        setBot(data);
        setPageBreadcrumbs([{ label: data.name }]);
      })
      .catch((caught: unknown) => {
        if (request !== requestRef.current) return;

        if (caught instanceof ApiError && caught.status === 403) {
          // ApiErrorBridge already explains the permission failure.
          router.replace(`/w/${workspaceId}/bots`);
          return;
        }

        if (caught instanceof ApiError && caught.status === 404) {
          toast('That bot could not be found.', 'error');
          router.replace(`/w/${workspaceId}/bots`);
          return;
        }

        setError(
          caught instanceof ApiError
            ? caught.message || 'We could not load this bot.'
            : 'We could not load this bot. Check your connection and try again.',
        );
      });
  }, [params.botId, router, setPageBreadcrumbs, toast, workspaceId]);

  useEffect(() => {
    void loadBot();

    return () => {
      requestRef.current += 1;
      setPageBreadcrumbs([]);
    };
  }, [loadBot, setPageBreadcrumbs]);

  useEffect(() => {
    if (!bot) return;

    let cancelled = false;
    getBotConfig(bot.id)
      .then(({ config }) => {
        if (cancelled) return;
        setAvatar({
          botId: bot.id,
          hasAvatar: config.general.hasAvatar,
          version: config.general.avatarVersion,
        });
      })
      .catch(() => {
        if (!cancelled) setAvatar(null);
      });

    return () => {
      cancelled = true;
    };
  }, [bot]);

  const retry = useCallback(() => {
    setBot(null);
    setError(null);
    void loadBot();
  }, [loadBot]);

  if (bot === null && error === null) {
    return <BotOverviewSkeleton />;
  }

  if (error) {
    return (
      <>
        <PageHeader
          title="Bot unavailable"
          description="This bot could not be opened."
          action={
            <Link href={`/w/${workspaceId}/bots`}>
              <Button
                variant="secondary"
                className="h-11 w-full sm:h-9 sm:w-auto"
              >
                Back to bots
              </Button>
            </Link>
          }
        />
        <div role="alert">
          <Card>
            <CardBody className="flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-xl">
                <p className="text-sm font-medium text-foreground">
                  We could not load this bot.
                </p>
                <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                  {error}
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={retry}
                className="h-11 w-full sm:h-9 sm:w-auto sm:shrink-0"
              >
                Try again
              </Button>
            </CardBody>
          </Card>
        </div>
      </>
    );
  }

  if (!bot) return null;

  const active = bot.isActive !== false;
  const modelName = bot.aiModel?.displayName ?? 'Platform default';
  const modelDisabled =
    bot.aiModel !== null &&
    bot.aiModel !== undefined &&
    (!bot.aiModel.enabled || !bot.aiModel.provider.enabled);
  const modelDetail = bot.aiModel
    ? modelDisabled
      ? `${bot.aiModel.provider.name} · Disabled`
      : bot.aiModel.provider.name
    : 'Set by the platform';
  const created = formatDate(bot.createdAt);
  const updated = formatDate(bot.updatedAt);
  const base = `/w/${workspaceId}/bots/${bot.id}`;

  return (
    <>
      <PageHeader
        title={bot.name}
        description={bot.description || 'No description.'}
        leading={
          <BotAvatar
            botId={bot.id}
            hasAvatar={avatar?.botId === bot.id ? avatar.hasAvatar : false}
            avatarVersion={avatar?.botId === bot.id ? avatar.version : 0}
            name={bot.name}
          />
        }
        action={
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={active ? 'success' : 'warning'} dot>
              {active ? 'Active' : 'Paused'}
            </Badge>
            <Link
              href={`/widget/${bot.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex"
            >
              <Button variant="secondary" className="h-11 sm:h-9">
                Preview
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            </Link>
          </div>
        }
      />

      <dl
        aria-label="Bot details"
        className="grid grid-cols-1 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-y-0"
      >
        <DetailCell
          label="Model"
          value={modelName}
          detail={modelDetail}
          warning={modelDisabled}
        />
        <DetailCell label="Created" value={created ?? '—'} />
        <DetailCell label="Last updated" value={updated ?? '—'} />
      </dl>

      {!active && (
        <p className="mt-3 text-[13px] leading-relaxed text-warning-bg-foreground">
          This bot is paused and will not answer new conversations until it is
          resumed in Configure.
        </p>
      )}

      <section aria-labelledby="bot-destinations" className="mt-6">
        <h2
          id="bot-destinations"
          className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          Work with this bot
        </h2>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DestinationCard
            href={`${base}/experience`}
            title="Experience"
            description="Design, preview, publish and deploy the customer chat."
          />
          <DestinationCard
            href={`${base}/knowledge`}
            title="Knowledge"
            description="Sources, FAQ entries, and retrieval tests."
          />
          <DestinationCard
            href={`${base}/configure`}
            title="Configure"
            description="Identity, model, behavior, and support hours."
          />
          <DestinationCard
            href={`${base}/conversations`}
            title="Conversations"
            description="Chat with the bot and review its history."
          />
        </div>
      </section>
    </>
  );
}

function DetailCell({
  label,
  value,
  detail,
  warning = false,
}: {
  label: string;
  value: string;
  detail?: string;
  warning?: boolean;
}) {
  return (
    <div className="px-5 py-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={`mt-1 text-sm font-medium ${
          warning ? 'text-warning-bg-foreground' : 'text-foreground'
        }`}
      >
        {value}
      </dd>
      {detail && (
        <dd className="mt-0.5 text-[12px] text-muted-foreground">{detail}</dd>
      )}
    </div>
  );
}

function DestinationCard({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-xl border border-border bg-card p-5 transition-colors hover:border-accent/50 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <span className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <ChevronRight
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none"
        />
      </span>
      <span className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
        {description}
      </span>
    </Link>
  );
}

function BotOverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading bot">
      <div aria-hidden="true">
        <div className="mb-6 flex items-start gap-3">
          <span className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2">
            <span className="block h-8 w-56 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <span className="block h-3.5 w-80 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        </div>

        <div className="grid grid-cols-1 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {[0, 1, 2].map((cell) => (
            <div key={cell} className="px-5 py-4">
              <span className="block h-3 w-16 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <span className="mt-2 block h-4 w-28 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            </div>
          ))}
        </div>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((card) => (
            <span
              key={card}
              className="block h-28 animate-pulse rounded-xl border border-border bg-card motion-reduce:animate-none"
            />
          ))}
        </div>
      </div>
      <span className="sr-only">
        <Spinner size="sm" /> Loading bot…
      </span>
    </div>
  );
}
