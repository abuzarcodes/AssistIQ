'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronRight, Plus } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api-client';
import { listBots, type Bot } from '@/lib/api/bots';
import { WORKSPACE_PERMISSIONS } from '@/lib/permissions';
import { useWorkspace } from '@/lib/workspace-context';
import { CreateBotDialog } from './_components/create-bot-dialog';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : DATE_FORMATTER.format(date);
}

function errorMessage(caught: unknown) {
  if (caught instanceof ApiError) {
    return caught.message || 'We could not load the bots in this workspace.';
  }
  return 'We could not load the bots in this workspace. Check your connection and try again.';
}

/**
 * Bots listing (CP5).
 *
 * The page answers one question: which assistants work in this workspace, and
 * is each one answering? It uses the real `listBots` result — no counts or
 * statuses are invented. Creation is gated on `bots:manage`; the server is
 * still the authority for the POST.
 */
export default function WorkspaceBotsPage() {
  const { workspaceId, hasPermission } = useWorkspace();
  const router = useRouter();
  const searchParams = useSearchParams();
  const createRequested = searchParams.get('create') === 'true';

  const [bots, setBots] = useState<Bot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createDismissed, setCreateDismissed] = useState(false);
  const requestRef = useRef(0);

  const canManage = hasPermission(WORKSPACE_PERMISSIONS.BOTS_MANAGE);
  const showCreateDialog =
    canManage && !createDismissed && (dialogOpen || createRequested);

  const loadBots = useCallback(() => {
    const request = ++requestRef.current;

    return listBots(workspaceId)
      .then((data) => {
        if (request === requestRef.current) {
          setBots(data);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (request === requestRef.current) setError(errorMessage(caught));
      });
  }, [workspaceId]);

  useEffect(() => {
    void loadBots();

    return () => {
      requestRef.current += 1;
    };
  }, [loadBots]);

  const openCreate = useCallback(() => {
    setCreateDismissed(false);
    setDialogOpen(true);
  }, []);

  const closeCreate = useCallback(() => {
    setDialogOpen(false);
    setCreateDismissed(true);

    // `/bots?create=true` comes from the dashboard's quick actions. Once the
    // dialog is closed, leave the query behind so a refresh does not reopen it.
    if (createRequested) {
      router.replace(`/w/${workspaceId}/bots`, { scroll: false });
    }
  }, [createRequested, router, workspaceId]);

  const handleCreated = useCallback((created: Bot) => {
    setBots((current) => (current ? [created, ...current] : [created]));
  }, []);

  const retry = useCallback(() => {
    setBots(null);
    setError(null);
    void loadBots();
  }, [loadBots]);

  const activeBots = bots?.filter((bot) => bot.isActive !== false).length ?? 0;
  const pausedBots = bots ? bots.length - activeBots : 0;

  let description: ReactNode;
  if (error) {
    description = 'Bots unavailable.';
  } else if (bots === null) {
    description = (
      <span role="status" className="inline-flex items-center gap-2">
        <Spinner size="sm" />
        Loading bots…
      </span>
    );
  } else if (bots.length === 0) {
    description = '0 bots in this workspace.';
  } else if (pausedBots === 0) {
    description =
      bots.length === 1
        ? 'The one bot in this workspace is active.'
        : `All ${bots.length} bots are active.`;
  } else {
    description = `${activeBots} active, ${pausedBots} paused.`;
  }

  return (
    <>
      <div>
        <PageHeader
          title="Bots"
          description={description}
          action={
            canManage && bots !== null && bots.length > 0 ? (
              <Button
                onClick={openCreate}
                className="h-11 w-full sm:h-9 sm:w-auto"
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                Create bot
              </Button>
            ) : undefined
          }
        />

        {error ? (
          <BotsError message={error} onRetry={retry} />
        ) : bots === null ? (
          <BotsSkeleton />
        ) : bots.length === 0 ? (
          <EmptyBots canManage={canManage} onCreate={openCreate} />
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-border">
              {bots.map((bot) => (
                <BotRow key={bot.id} workspaceId={workspaceId} bot={bot} />
              ))}
            </ul>
          </Card>
        )}
      </div>

      {canManage && (
        <CreateBotDialog
          workspaceId={workspaceId}
          open={showCreateDialog}
          onClose={closeCreate}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}

function BotRow({ workspaceId, bot }: { workspaceId: string; bot: Bot }) {
  const active = bot.isActive !== false;
  const initial = bot.name.trim().charAt(0).toUpperCase() || '?';
  const updated = formatDate(bot.updatedAt);
  const base = `/w/${workspaceId}/bots/${bot.id}`;

  return (
    <li className="flex items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/40 sm:gap-5">
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-[13px] font-semibold text-muted-foreground"
      >
        {initial}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={base}
            className="inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-foreground transition-colors hover:text-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
          >
            {bot.name}
          </Link>
          <Badge variant={active ? 'success' : 'warning'} dot>
            {active ? 'Active' : 'Paused'}
          </Badge>
        </div>

        <p className="mt-1 line-clamp-2 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
          {bot.description || 'No description.'}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <RowAction href={`${base}/knowledge`}>Knowledge</RowAction>
          <RowAction href={`${base}/configure`}>Configure</RowAction>
          <RowAction href={`${base}/conversations`}>Conversations</RowAction>
        </div>
      </div>

      <div className="hidden shrink-0 flex-col items-end gap-0.5 text-right sm:flex">
        <span className="max-w-[180px] truncate text-[12px] font-medium text-foreground">
          {bot.aiModel?.displayName ?? 'Platform default'}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {updated ? `Updated ${updated}` : 'No update date'}
        </span>
        <Link
          href={base}
          aria-label={`Open ${bot.name} overview`}
          className="mt-1 inline-flex min-h-7 items-center gap-1 rounded-sm text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Overview
          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      </div>
    </li>
  );
}

function RowAction({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 items-center rounded-sm text-[13px] font-medium text-muted-foreground transition-colors hover:text-accent-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0"
    >
      {children}
    </Link>
  );
}

function EmptyBots({
  canManage,
  onCreate,
}: {
  canManage: boolean;
  onCreate: () => void;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-6 py-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-xl">
          <p className="text-sm font-medium text-foreground">No bots yet</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            Create a bot to answer customers with the knowledge you add to this
            workspace.
          </p>
        </div>

        {canManage ? (
          <Button
            onClick={onCreate}
            className="h-11 w-full sm:h-9 sm:w-auto sm:shrink-0"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            Create bot
          </Button>
        ) : (
          <p className="max-w-xs text-[13px] leading-relaxed text-muted-foreground sm:text-right">
            An owner or admin can create the first bot for this workspace.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function BotsError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert">
      <Card>
        <CardBody className="flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl">
            <p className="text-sm font-medium text-foreground">
              We could not load these bots.
            </p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {message}
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={onRetry}
            className="h-11 w-full sm:h-9 sm:w-auto sm:shrink-0"
          >
            Try again
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

function BotsSkeleton() {
  return (
    <Card className="overflow-hidden" aria-busy="true" aria-label="Loading bots">
      <div className="divide-y divide-border" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-start gap-4 px-5 py-4">
            <span className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="block h-3.5 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                <span className="block h-5 w-16 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
              </div>
              <span className="block h-3 w-72 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <span className="block h-3 w-56 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
