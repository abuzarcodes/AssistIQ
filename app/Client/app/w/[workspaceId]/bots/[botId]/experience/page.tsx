'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { getBot, type Bot } from '@/lib/api/bots';
import {
  getBotConfig,
  type BotConfigResponse,
} from '@/lib/api/botConfig';
import {
  getExperience,
  type ExperienceResponse,
} from '@/lib/api/experience';
import { WORKSPACE_PERMISSIONS } from '@/lib/permissions';
import { useWorkspace } from '@/lib/workspace-context';
import { ExperienceStudio } from './_components/experience-studio';
import type {
  ExperienceAvatar,
  ExperienceFallbacks,
} from './_components/experience-types';

interface PublicationBadge {
  variant: 'default' | 'success' | 'warning';
  label: string;
}

/**
 * What the badge says about the live experience.
 *
 * A published snapshot that no deployment currently serves is a draft, not a
 * live experience: the version still shows so an owner can see what would be
 * restored by publishing again.
 */
function publicationBadge(experience: ExperienceResponse): PublicationBadge {
  const live = experience.deployments.some(
    (deployment) => deployment.status === 'PUBLISHED' && deployment.enabled,
  );

  if (live && experience.publishedVersion) {
    return {
      variant: 'success',
      label: `Published v${experience.publishedVersion.versionNumber}`,
    };
  }

  if (experience.publishedVersion) {
    return {
      variant: 'warning',
      label: `Draft · v${experience.publishedVersion.versionNumber} not live`,
    };
  }

  return { variant: 'default', label: 'Draft' };
}

/**
 * Bot Experience Studio (Phase 8 shell, Phase 9 editor).
 *
 * The page owns the bot record, permission and breadcrumbs; `ExperienceStudio`
 * owns the draft, its save state and its conflict handling. The bot configuration
 * is read alongside them because its values are the fallbacks the Design tab names
 * and the placeholder the server's `effective` block does not resolve.
 */
export default function WorkspaceBotExperiencePage() {
  const { workspaceId, hasPermission, setPageBreadcrumbs } = useWorkspace();
  const params = useParams<{ botId: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const [bot, setBot] = useState<Bot | null>(null);
  const [experience, setExperience] = useState<ExperienceResponse | null>(null);
  const [botConfig, setBotConfig] = useState<BotConfigResponse | null>(null);
  const [avatar, setAvatar] = useState<ExperienceAvatar>({
    hasAvatar: false,
    avatarVersion: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const canManage = hasPermission(WORKSPACE_PERMISSIONS.BOTS_MANAGE);

  const load = useCallback(() => {
    const request = ++requestRef.current;

    return Promise.all([
      getBot(params.botId),
      getExperience(params.botId),
      getBotConfig(params.botId),
    ])
      .then(([botData, experienceData, configData]) => {
        if (request !== requestRef.current) return;

        if (botData.workspaceId !== workspaceId) {
          router.replace(
            `/w/${botData.workspaceId}/bots/${botData.id}/experience`,
          );
          return;
        }

        setBot(botData);
        setExperience(experienceData);
        setBotConfig(configData);
        setAvatar({
          hasAvatar: configData.config.general.hasAvatar,
          avatarVersion: configData.config.general.avatarVersion,
        });
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
            ? caught.message || 'We could not load this experience.'
            : 'We could not load this experience. Check your connection and try again.',
        );
      });
  }, [params.botId, router, toast, workspaceId]);

  useEffect(() => {
    void load();

    return () => {
      requestRef.current += 1;
      setPageBreadcrumbs([]);
    };
  }, [load, setPageBreadcrumbs]);

  useEffect(() => {
    if (!bot) return;

    setPageBreadcrumbs([
      {
        label: bot.name,
        href: `/w/${workspaceId}/bots/${bot.id}`,
      },
      { label: 'Experience' },
    ]);
  }, [bot, setPageBreadcrumbs, workspaceId]);

  const retry = useCallback(() => {
    setBot(null);
    setExperience(null);
    setBotConfig(null);
    setError(null);
    void load();
  }, [load]);

  /**
   * The values the chat shows when the experience leaves a field empty. Built from the
   * bot configuration, which is the same source the server's `effective` block uses for
   * the name and welcome message. The placeholder is not resolved by the server, so it
   * is read straight from the configuration here.
   */
  const fallbacks = useMemo<ExperienceFallbacks | null>(() => {
    if (!bot || !botConfig) return null;

    return {
      displayName: botConfig.config.general.displayName || bot.name,
      welcomeMessage: botConfig.config.conversation.welcomeMessage,
      inputPlaceholder: botConfig.config.conversation.inputPlaceholder,
      suggestedQuestions: botConfig.config.conversation.suggestedQuestions,
    };
  }, [bot, botConfig]);

  if (bot === null && error === null) {
    return <ExperienceSkeleton />;
  }

  if (error) {
    return (
      <>
        <PageHeader
          title="Experience unavailable"
          description="This bot’s experience could not be opened."
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
                  We could not load this experience.
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

  if (!bot || !experience || !botConfig || !fallbacks) return null;

  const publication = publicationBadge(experience);

  return (
    <>
      <PageHeader
        title={bot.name}
        description="Bot Experience Studio"
        action={
          <div className="flex flex-wrap items-center gap-2">
            {!canManage && <Badge variant="warning">Read only</Badge>}
            <Badge variant={publication.variant} dot>
              {publication.label}
            </Badge>
          </div>
        }
      />

      <section
        aria-label={`${bot.name} experience`}
        className="rounded-2xl border border-border bg-card p-4 sm:p-5"
      >
        <ExperienceStudio
          initialExperience={experience}
          canManage={canManage}
          botId={bot.id}
          botName={bot.name}
          avatar={avatar}
          fallbacks={fallbacks}
          aiDraft={botConfig.config}
          onExperienceChange={setExperience}
          onAvatarChanged={(state) =>
            setAvatar((previous) => ({
              hasAvatar: state !== null,
              avatarVersion: state?.avatarVersion ?? previous.avatarVersion,
            }))
          }
        />
      </section>
    </>
  );
}

function ExperienceSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading experience"
    >
      <div aria-hidden="true">
        <div className="mb-6 flex items-start gap-3">
          <span className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="min-w-0 flex-1 space-y-2">
            <span className="block h-8 w-52 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <span className="block h-3.5 w-36 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
          <div className="flex gap-4 border-b border-border pb-3">
            {[0, 1, 2, 3, 4].map((tab) => (
              <span
                key={tab}
                className="block h-4 w-16 animate-pulse rounded bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
          <div className="mt-5 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <span className="block h-3 w-20 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <span className="block h-9 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
                <span className="block h-9 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
              </div>
              <span className="block h-24 w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
            </div>
            <span className="block h-52 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
          </div>
        </div>
      </div>
      <span className="sr-only">
        <Spinner size="sm" /> Loading experience…
      </span>
    </div>
  );
}
