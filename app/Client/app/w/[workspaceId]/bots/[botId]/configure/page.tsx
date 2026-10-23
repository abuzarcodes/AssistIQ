'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import type { AvatarState, BotConfigResponse } from '@/lib/api/botConfig';
import { deleteBot, getBot, type Bot } from '@/lib/api/bots';
import { listAvailableModels, type SelectableModel } from '@/lib/api/models';
import { WORKSPACE_PERMISSIONS } from '@/lib/permissions';
import { useWorkspace } from '@/lib/workspace-context';
import { BotAvatar } from '../_components/bot-avatar';
import { BotConfigTabs } from '../_components/bot-config-tabs';

interface AvatarSummary {
  hasAvatar: boolean;
  version: number;
}

/**
 * Workspace bot configuration (CP6).
 *
 * The page is the bot's editing sheet: one white working surface on the warm
 * workspace ground, with the section rail, the active section and the live
 * preview sharing the same frame. It owns the bot record and its lifecycle;
 * `BotConfigTabs` owns the configuration draft, save bar and conflict handling.
 *
 * Permission comes from the already-loaded workspace context rather than a
 * second workspace request. An unknown role grants nothing, so the surface
 * renders read-only until the role is known.
 */
export default function WorkspaceBotConfigurePage() {
  const { workspaceId, hasPermission, setPageBreadcrumbs } = useWorkspace();
  const params = useParams<{ botId: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const [bot, setBot] = useState<Bot | null>(null);
  const [avatar, setAvatar] = useState<AvatarSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<SelectableModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const requestRef = useRef(0);
  const modelsRequestRef = useRef(0);

  const canManage = hasPermission(WORKSPACE_PERMISSIONS.BOTS_MANAGE);

  const loadBot = useCallback(() => {
    const request = ++requestRef.current;

    return getBot(params.botId)
      .then((data) => {
        if (request !== requestRef.current) return;

        if (data.workspaceId !== workspaceId) {
          router.replace(
            `/w/${data.workspaceId}/bots/${data.id}/configure`,
          );
          return;
        }

        setBot(data);
        setError(null);
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
  }, [params.botId, router, toast, workspaceId]);

  const loadModels = useCallback(() => {
    const request = ++modelsRequestRef.current;

    return listAvailableModels()
      .then((data) => {
        if (request !== modelsRequestRef.current) return;
        setModels(data);
        setModelsError(false);
      })
      .catch(() => {
        if (request === modelsRequestRef.current) setModelsError(true);
      })
      .finally(() => {
        if (request === modelsRequestRef.current) setModelsLoading(false);
      });
  }, []);

  useEffect(() => {
    void loadBot();
    void loadModels();

    return () => {
      requestRef.current += 1;
      modelsRequestRef.current += 1;
      setPageBreadcrumbs([]);
    };
  }, [loadBot, loadModels, setPageBreadcrumbs]);

  useEffect(() => {
    if (!bot) return;

    setPageBreadcrumbs([
      {
        label: bot.name,
        href: `/w/${workspaceId}/bots/${bot.id}`,
      },
      { label: 'Configure' },
    ]);
  }, [bot, setPageBreadcrumbs, workspaceId]);

  const handleConfigLoaded = useCallback((response: BotConfigResponse) => {
    setAvatar({
      hasAvatar: response.config.general.hasAvatar,
      version: response.config.general.avatarVersion,
    });
  }, []);

  const handleAvatarChanged = useCallback((state: AvatarState | null) => {
    setAvatar((prev) => ({
      hasAvatar: state !== null,
      version: state?.avatarVersion ?? (prev?.version ?? 0) + 1,
    }));
  }, []);

  const retry = useCallback(() => {
    setBot(null);
    setError(null);
    setModelsLoading(true);
    setModelsError(false);
    void loadBot();
    void loadModels();
  }, [loadBot, loadModels]);

  async function handleDelete() {
    if (!bot) return;

    setDeleting(true);
    try {
      await deleteBot(bot.id);
      toast('Bot deleted', 'success');
      router.push(`/w/${workspaceId}/bots`);
    } catch (caught) {
      toast(
        caught instanceof ApiError ? caught.message : 'Failed to delete bot',
        'error',
      );
    } finally {
      setDeleting(false);
    }
  }

  if (bot === null && error === null) {
    return <ConfigureSkeleton />;
  }

  if (error) {
    return (
      <>
        <PageHeader
          title="Bot unavailable"
          description="This configuration could not be opened."
          action={
            <Link href={`/w/${workspaceId}/bots`}>
              <Button variant="secondary" className="h-11 w-full sm:h-9 sm:w-auto">
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
  const avatarState =
    avatar ?? { hasAvatar: false, version: 0 };

  return (
    <>
      <PageHeader
        title={bot.name}
        description="Configuration"
        leading={
          <BotAvatar
            botId={bot.id}
            hasAvatar={avatarState.hasAvatar}
            avatarVersion={avatarState.version}
            name={bot.name}
          />
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {!canManage && <Badge variant="warning">Read only</Badge>}
            <Badge variant={active ? 'success' : 'warning'} dot>
              {active ? 'Active' : 'Paused'}
            </Badge>
          </div>
        }
      />

      <section
        aria-label={`${bot.name} configuration`}
        className="rounded-2xl border border-border bg-card"
      >
        <BotConfigTabs
          bot={bot}
          models={models}
          modelsLoading={modelsLoading}
          modelsError={modelsError}
          canManage={canManage}
          onBotChanged={setBot}
          onConfigLoaded={handleConfigLoaded}
          onAvatarChanged={handleAvatarChanged}
        />
      </section>

      {canManage && (
        <section
          aria-labelledby="danger-zone-title"
          className="mt-6 rounded-2xl border border-destructive/30 bg-card px-4 py-4 sm:px-5"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2
                id="danger-zone-title"
                className="text-sm font-semibold text-error-bg-foreground"
              >
                Delete this bot
              </h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
                Permanently remove this bot with its conversations, knowledge
                entries and embeddings. This cannot be undone.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="h-11 shrink-0 border-destructive/40 text-error-bg-foreground hover:bg-error-bg hover:text-error-bg-foreground sm:h-9"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Delete bot
            </Button>
          </div>
        </section>
      )}

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete bot"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete{' '}
            <strong className="text-foreground">{bot.name}</strong>? This will
            permanently delete:
          </p>
          <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
            <li>All conversations and messages</li>
            <li>All knowledge entries</li>
            <li>All vector embeddings</li>
          </ul>
          <p className="text-sm font-medium text-error-bg-foreground">
            This action cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={deleting}
              onClick={handleDelete}
            >
              Delete bot
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function ConfigureSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading bot configuration"
    >
      <div aria-hidden="true">
        <div className="mb-6 flex items-start gap-3">
          <span className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2">
            <span className="block h-8 w-52 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <span className="block h-3.5 w-36 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 rounded-2xl border border-border bg-card p-3 lg:grid-cols-[172px_minmax(0,1fr)]">
          <div className="hidden space-y-2 lg:block">
            {[0, 1, 2, 3, 4].map((row) => (
              <span
                key={row}
                className="block h-9 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
          <div className="space-y-4 p-2">
            <span className="block h-3 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <span className="block h-7 w-48 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="space-y-3 pt-3">
              <span className="block h-3 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <span className="block h-9 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
              <span className="block h-3 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <span className="block h-20 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
            </div>
          </div>
        </div>
      </div>
      <span className="sr-only">
        <Spinner size="sm" /> Loading bot configuration…
      </span>
    </div>
  );
}
