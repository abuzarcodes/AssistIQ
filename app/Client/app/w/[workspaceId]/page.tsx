'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { listBots, type Bot } from '@/lib/api/bots';
import {
  fetchQueue,
  type MessageRole,
  type QueueItem,
} from '@/lib/api/conversations';
import { WORKSPACE_PERMISSIONS } from '@/lib/permissions';
import { useWorkspace } from '@/lib/workspace-context';
import type { WorkspaceRole } from '@/lib/api/workspaces';

/**
 * The support queue is capped at the API's maximum page size. When the endpoint
 * reports more than this, the dashboard shows "100+" rather than inventing an
 * exact total the API does not expose.
 */
const QUEUE_LIMIT = 100;

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  AGENT: 'Agent',
};

const REASON_LABELS: Record<string, string> = {
  NO_RELEVANT_KNOWLEDGE: 'No relevant knowledge',
  LOW_RETRIEVAL_CONFIDENCE: 'Low retrieval confidence',
  LLM_INSUFFICIENT_INFORMATION: 'The bot was unsure',
  LOW_CLASSIFICATION_CONFIDENCE: 'Low classification confidence',
  MODEL_UNAVAILABLE: 'Model unavailable',
  MODEL_RATE_LIMITED: 'Model rate limited',
  MODEL_ERROR: 'Model error',
};

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

interface DashboardData {
  bots: Bot[];
  queueItems: QueueItem[];
  queueHasMore: boolean;
}

/**
 * Workspace Dashboard (CP4).
 *
 * The page answers one question first: is anyone waiting for a person? The
 * support queue is the only coloured figure in the summary strip and, when it
 * is not empty, the largest block on the page. Everything here comes from
 * `listBots` and the unassigned queue — there are no placeholder metrics.
 */
export default function WorkspaceDashboardPage() {
  const { workspace, workspaceId, viewerRole, hasPermission } = useWorkspace();
  const { toast } = useToast();
  const router = useRouter();

  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const errorToastShownRef = useRef(false);

  const fetchDashboard = useCallback(async (): Promise<DashboardData> => {
    const [bots, queue] = await Promise.all([
      listBots(workspaceId),
      fetchQueue(workspaceId, { view: 'unassigned', limit: QUEUE_LIMIT }),
    ]);

    return {
      bots,
      queueItems: queue.items,
      queueHasMore: queue.pagination.hasMore,
    };
  }, [workspaceId]);

  const handleFailure = useCallback(
    (caught: unknown) => {
      setData(null);
      setError(
        caught instanceof ApiError
          ? caught.message || 'We could not load this workspace overview.'
          : 'We could not load this workspace overview. Check your connection and try again.',
      );

      // A 403 is already explained by ApiErrorBridge. For every other failure,
      // show one toast per failed attempt, not one per request in the pair.
      const isForbidden = caught instanceof ApiError && caught.status === 403;
      if (!isForbidden && !errorToastShownRef.current) {
        toast('We could not load the workspace overview.', 'error');
        errorToastShownRef.current = true;
      }
    },
    [toast],
  );

  const loadDashboard = useCallback(() => {
    const request = ++requestRef.current;

    return fetchDashboard()
      .then((result) => {
        if (request !== requestRef.current) return;
        setData(result);
        setError(null);
        errorToastShownRef.current = false;
      })
      .catch((caught: unknown) => {
        if (request === requestRef.current) handleFailure(caught);
      });
  }, [fetchDashboard, handleFailure]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(
    () => () => {
      // Invalidate an in-flight response if the page unmounts.
      requestRef.current += 1;
    },
    [],
  );

  const retry = useCallback(() => {
    errorToastShownRef.current = false;
    setData(null);
    void loadDashboard();
  }, [loadDashboard]);

  if (!workspace) return null;

  const loading = data === null && error === null;
  const activeBots = data
    ? data.bots.filter((bot) => bot.isActive !== false).length
    : 0;
  const unassignedCount = data?.queueItems.length ?? 0;
  const unassignedLabel =
    data && data.queueHasMore ? `${QUEUE_LIMIT}+` : String(unassignedCount);
  const canManageBots = hasPermission(WORKSPACE_PERMISSIONS.BOTS_MANAGE);

  const createdLabel = formatDate(workspace.createdAt);
  const meta = [
    viewerRole ? ROLE_LABELS[viewerRole] : null,
    createdLabel ? `Created ${createdLabel}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  let finding: string | undefined;
  if (data) {
    if (data.queueHasMore) {
      finding = `More than ${QUEUE_LIMIT} conversations are waiting for a person.`;
    } else if (unassignedCount > 0) {
      finding =
        unassignedCount === 1
          ? '1 conversation is waiting for a person.'
          : `${unassignedCount} conversations are waiting for a person.`;
    } else if (data.bots.length === 0) {
      finding = 'No bots yet. Set up this workspace to start answering customers.';
    } else {
      finding = 'No one is waiting in the support queue.';
    }
  }

  const showQueueAction =
    data !== null && data.bots.length > 0 && unassignedCount > 0;

  const headerAction = showQueueAction ? (
    <Button
      onClick={() => router.push(`/w/${workspaceId}/inbox`)}
      className="w-full sm:w-auto"
    >
      Open support inbox
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        title={workspace.name}
        description={
          loading ? (
            <span role="status" className="inline-flex items-center gap-2">
              <Spinner size="sm" />
              Loading workspace data…
            </span>
          ) : error ? (
            'Overview unavailable.'
          ) : (
            finding
          )
        }
        action={headerAction}
      />

      {loading ? (
        <DashboardSkeleton />
      ) : error ? (
        <DashboardError message={error} onRetry={retry} />
      ) : data ? (
        <>
          <SummaryStrip
            bots={data.bots.length}
            activeBots={activeBots}
            unassigned={unassignedLabel}
            hasUnassigned={unassignedCount > 0}
          />

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2">
              {data.bots.length === 0 ? (
                <SetupPanel
                  canManage={canManageBots}
                  onCreate={() => router.push(`/w/${workspaceId}/bots?create=true`)}
                />
              ) : (
                <QueuePanel
                  workspaceId={workspaceId}
                  items={data.queueItems}
                  hasMore={data.queueHasMore}
                />
              )}
            </div>

            <div className="min-w-0">
              <QuickActions
                workspaceId={workspaceId}
                showCreate={canManageBots && data.bots.length > 0}
                pinFooter={data.bots.length > 0}
                meta={meta}
              />
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

function SummaryStrip({
  bots,
  activeBots,
  unassigned,
  hasUnassigned,
}: {
  bots: number;
  activeBots: number;
  unassigned: string;
  hasUnassigned: boolean;
}) {
  return (
    <dl
      aria-label="Workspace summary"
      className="grid grid-cols-1 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-y-0"
    >
      <SummaryCell label="Bots" value={String(bots)} />
      <SummaryCell label="Active bots" value={String(activeBots)} />
      <SummaryCell
        label="Unassigned"
        value={unassigned}
        accent={hasUnassigned}
      />
    </dl>
  );
}

function SummaryCell({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-5 py-4 sm:block">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={`text-2xl font-semibold tabular-nums sm:mt-1.5 ${
          accent ? 'text-accent-strong' : 'text-foreground'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function QueuePanel({
  workspaceId,
  items,
  hasMore,
}: {
  workspaceId: string;
  items: QueueItem[];
  hasMore: boolean;
}) {
  const visibleItems = items.slice(0, 3);

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader>
        <CardTitle as="h2">Needs attention</CardTitle>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {items.length === 0
            ? 'The unassigned support queue is clear.'
            : 'Unassigned conversations, oldest first.'}
        </p>
      </CardHeader>

      {items.length === 0 ? (
        <div className="grid flex-1 gap-6 px-5 py-5 md:grid-cols-[minmax(0,1fr)_14rem]">
          <div className="flex flex-col justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">
                No one is waiting for a person.
              </p>
              <p className="mt-1 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
                When a customer asks for a person, the conversation appears
                here until someone on the team claims it.
              </p>
            </div>

            <ol className="list-decimal space-y-1.5 pl-4 text-[13px] leading-relaxed text-muted-foreground">
              <li>A customer asks for a person.</li>
              <li>The conversation lands here.</li>
              <li>Someone on the team claims it.</li>
              <li>Someone replies and resolves it.</li>
            </ol>

            <Link
              href={`/w/${workspaceId}/inbox`}
              className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-accent-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              Open support inbox
              <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="border-t border-border pt-4 md:border-l md:border-t-0 md:pl-6 md:pt-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              When it fills
            </p>
            <dl className="mt-3 space-y-3">
              <div>
                <dt className="text-xs font-medium text-foreground">Bot</dt>
                <dd className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                  The assistant that escalated.
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-foreground">Reason</dt>
                <dd className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                  Why the bot asked for a person.
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-foreground">Waiting</dt>
                <dd className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                  How long the customer has waited.
                </dd>
              </div>
            </dl>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {visibleItems.map((item) => (
            <QueueRow key={item.id} workspaceId={workspaceId} item={item} />
          ))}
        </ul>
      )}

      {hasMore && (
        <p className="mt-auto border-t border-border px-5 py-3 text-xs text-muted-foreground">
          Showing the three oldest conversations.
        </p>
      )}
    </Card>
  );
}

function QueueRow({
  workspaceId,
  item,
}: {
  workspaceId: string;
  item: QueueItem;
}) {
  const lastMessage = item.messages?.[0];
  const reason = formatReason(item.escalationReason);
  const waited = formatWait(item.escalatedAt ?? item.createdAt);

  return (
    <li>
      <Link
        href={`/w/${workspaceId}/inbox`}
        className="group flex items-start gap-4 px-5 py-4 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium text-foreground">
              Visitor #{item.id.slice(0, 6)}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {item.bot?.name ?? 'Unknown bot'}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
            {reason}
          </p>
          {lastMessage && (
            <p className="mt-1 line-clamp-1 text-[13px] text-muted-foreground">
              <span className="font-medium text-foreground">
                {roleLabel(lastMessage.role)}:{' '}
              </span>
              {lastMessage.content}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <div className="text-right">
            <span className="block text-[11px] text-muted-foreground">
              Waiting
            </span>
            <span className="mt-0.5 block text-xs font-medium tabular-nums text-foreground">
              {waited}
            </span>
          </div>
          <ChevronRight
            aria-hidden="true"
            className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground"
          />
        </div>
      </Link>
    </li>
  );
}

function QuickActions({
  workspaceId,
  showCreate,
  pinFooter,
  meta,
}: {
  workspaceId: string;
  showCreate: boolean;
  pinFooter: boolean;
  meta: string;
}) {
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader>
        <CardTitle as="h2">Quick actions</CardTitle>
      </CardHeader>

      <div className="divide-y divide-border">
        {showCreate && (
          <QuickActionLink
            href={`/w/${workspaceId}/bots?create=true`}
            label="Create bot"
            description="Start a new assistant for this workspace."
          />
        )}
        <QuickActionLink
          href={`/w/${workspaceId}/bots`}
          label="View bots"
          description="Open, pause, or configure assistants."
        />
        <QuickActionLink
          href={`/w/${workspaceId}/inbox`}
          label="Support inbox"
          description="See every conversation that needs a person."
        />
      </div>

      {meta && (
        <div
          className={`border-t border-border px-5 py-4 ${
            pinFooter ? 'mt-auto' : ''
          }`}
        >
          <p className="text-xs font-medium text-muted-foreground">Workspace</p>
          <div className="mt-1 space-y-0.5">
            {meta.split(' · ').map((line) => (
              <p key={line} className="text-[13px] text-muted-foreground">
                {line}
              </p>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function QuickActionLink({
  href,
  label,
  description,
}: {
  href: string;
  label: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-[13px] text-muted-foreground">
          {description}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
      />
    </Link>
  );
}

function SetupPanel({
  canManage,
  onCreate,
}: {
  canManage: boolean;
  onCreate: () => void;
}) {
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader>
        <CardTitle>Start with a bot</CardTitle>
        <p className="mt-1 text-[13px] text-muted-foreground">
          A bot is the assistant customers talk to.
        </p>
      </CardHeader>

      <CardBody className="flex flex-1 flex-col">
        <p className="max-w-xl text-sm leading-relaxed text-foreground">
          This workspace has no bots yet. Create one, decide what it knows, and
          share it with your customers.
        </p>

        <ul className="mt-4 max-w-xl list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-muted-foreground marker:text-muted-foreground">
          <li>Give the bot a name and a short description.</li>
          <li>Add the knowledge it should answer from.</li>
          <li>Share the chat widget when it is ready.</li>
        </ul>

        {canManage ? (
          <div className="mt-auto pt-6">
            <Button onClick={onCreate} className="w-full sm:w-auto">
              Create bot
            </Button>
          </div>
        ) : (
          <p className="mt-auto pt-6 text-[13px] text-muted-foreground">
            An owner or admin can create the first bot for this workspace.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function DashboardError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert">
      <Card>
        <CardBody className="flex flex-col items-start gap-3 py-8">
          <p className="text-sm font-medium text-foreground">
            We could not load this overview.
          </p>
          <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
            {message}
          </p>
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="grid grid-cols-1 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {[0, 1, 2].map((cell) => (
          <div key={cell} className="px-5 py-4">
            <span className="block h-3 w-16 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <span className="mt-3 block h-7 w-10 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
          <span className="block h-3.5 w-28 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <span className="mt-2 block h-3 w-56 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="mt-7 space-y-5">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-start justify-between gap-6">
                <div className="flex-1 space-y-2">
                  <span className="block h-3 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                  <span className="block h-3 w-20 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                  <span className="block h-3 w-56 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
                </div>
                <span className="block h-3 w-12 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-5">
          <span className="block h-3.5 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="mt-6 space-y-5">
            {[0, 1, 2].map((row) => (
              <div key={row} className="space-y-2">
                <span className="block h-3 w-28 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                <span className="block h-3 w-44 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatDate(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : DATE_FORMATTER.format(date);
}

function formatReason(reason: string | null) {
  if (!reason) return 'Reason not recorded';
  return (
    REASON_LABELS[reason] ??
    reason
      .replaceAll('_', ' ')
      .toLowerCase()
      .replace(/^\w/, (letter) => letter.toUpperCase())
  );
}

function roleLabel(role: MessageRole) {
  if (role === 'USER') return 'Customer';
  if (role === 'AGENT') return 'Agent';
  return 'Bot';
}

function formatWait(iso: string) {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';

  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainder = minutes % 60;
    return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
  }

  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder ? `${days} d ${remainder} h` : `${days} d`;
}
