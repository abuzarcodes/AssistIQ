'use client';

import { Badge } from '@/components/ui/badge';
import {
  CHAT_PREVIEW_SURFACES,
  EXPERIENCE_DEFAULTS,
  EXPERIENCE_THEME_PRESETS,
  isHexColor,
  isHttpUrl,
  readableInk,
} from '@/lib/experience/config';
import type {
  ExperienceResponse,
  ExperienceThemeMode,
} from '@/lib/api/experience';
import { BotAvatar } from '../../_components/bot-avatar';
import type {
  ExperienceAvatar,
  ExperienceFallbacks,
} from './experience-types';

interface ExperienceSummaryCardProps {
  draft: ExperienceResponse;
  fallbacks: ExperienceFallbacks;
  botId: string;
  botName: string;
  avatar: ExperienceAvatar;
}

function formatLabel(format: string): string {
  if (format === 'HOSTED_PAGE') return 'Hosted page';
  if (format === 'WIDGET') return 'Widget';
  if (format === 'IFRAME') return 'Iframe';
  return format;
}

function modeLabel(mode: ExperienceThemeMode): string {
  if (mode === 'light') return 'Light';
  if (mode === 'dark') return 'Dark';
  return 'System';
}

/**
 * The rail's live summary: a small chat drawn from the draft itself.
 *
 * It is deliberately not a screenshot and not the Phase 10 preview surface. Its job is
 * to answer one question at a glance — "did the colour, the name and the greeting I just
 * set actually take?" — while the owner is still in the form. The conversation below the
 * greeting is a sample, labelled as one, so nothing here can be mistaken for a live
 * transcript.
 *
 * The surfaces are explicit rather than dashboard tokens: a preview of a light
 * experience has to stay light while the owner works in dark mode.
 */
export function ExperienceSummaryCard({
  draft,
  fallbacks,
  botId,
  botName,
  avatar,
}: ExperienceSummaryCardProps) {
  const mode = draft.themeMode as ExperienceThemeMode;
  const tone = mode === 'dark' ? 'dark' : 'light';
  const surface = CHAT_PREVIEW_SURFACES[tone];

  const accent = isHexColor(draft.accentColor)
    ? draft.accentColor
    : EXPERIENCE_DEFAULTS.accentColor;
  const userBubble = isHexColor(draft.userBubbleColor)
    ? draft.userBubbleColor
    : accent;
  const botBubble = isHexColor(draft.botBubbleColor)
    ? draft.botBubbleColor
    : surface.panel;

  const name = draft.displayName || fallbacks.displayName || botName;
  const welcome =
    draft.welcomeMessage ||
    fallbacks.welcomeMessage ||
    'Hi — how can we help today?';
  const questions =
    draft.suggestedQuestions.length > 0
      ? draft.suggestedQuestions
      : fallbacks.suggestedQuestions;
  const placeholder =
    draft.inputPlaceholder ||
    fallbacks.inputPlaceholder ||
    'Type your message…';
  const logo =
    draft.businessLogoUrl && isHttpUrl(draft.businessLogoUrl)
      ? draft.businessLogoUrl
      : null;

  const presetName = draft.themePreset
    ? EXPERIENCE_THEME_PRESETS.find((preset) => preset.id === draft.themePreset)
        ?.name
    : undefined;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-baseline justify-between gap-2 px-4 pt-4">
        <h2 className="text-sm font-semibold text-foreground">Live summary</h2>
        <span className="text-xs text-muted-foreground">
          {presetName ? `${presetName} · ` : ''}
          {modeLabel(mode)}
        </span>
      </div>
      <p className="px-4 pb-3 text-xs leading-5 text-muted-foreground">
        Updates as you edit. The draft only reaches visitors when you publish.
      </p>

      <div className="px-3">
        <div
          className="overflow-hidden rounded-xl border"
          style={{ borderColor: surface.border, backgroundColor: surface.ground }}
          aria-label="Chat appearance preview"
        >
          <div
            className="flex items-center gap-2 px-3 py-2.5"
            style={{ borderBottom: `1px solid ${surface.border}` }}
          >
            <BotAvatar
              botId={botId}
              hasAvatar={avatar.hasAvatar}
              avatarVersion={avatar.avatarVersion}
              name={name}
              size="sm"
            />
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-xs font-semibold"
                style={{ color: surface.ink }}
              >
                {name}
              </p>
              <p className="text-[10px]" style={{ color: surface.muted }}>
                Online
              </p>
            </div>
            {logo && (
              // eslint-disable-next-line @next/next/no-img-element -- an owner-supplied remote URL is not known at build time.
              <img
                src={logo}
                alt={`${name} logo`}
                className="h-5 max-w-[64px] object-contain"
              />
            )}
          </div>

          <div className="flex flex-col gap-2 px-3 py-3">
            <div
              className="max-w-[85%] rounded-2xl rounded-tl-sm px-2.5 py-2 text-[11px] leading-4"
              style={{
                backgroundColor: botBubble,
                color: readableInk(botBubble),
              }}
            >
              {welcome}
            </div>

            {draft.firstOpenBehavior !== 'empty' && questions.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {questions.slice(0, 3).map((question) => (
                  <span
                    key={question}
                    className="max-w-full truncate rounded-full border px-2 py-0.5 text-[10px]"
                    style={{ borderColor: accent, color: accent }}
                  >
                    {question}
                  </span>
                ))}
                {questions.length > 3 && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10px]"
                    style={{ backgroundColor: surface.panel, color: surface.muted }}
                  >
                    +{questions.length - 3}
                  </span>
                )}
              </div>
            )}

            <div
              className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm px-2.5 py-2 text-[11px] leading-4"
              style={{ backgroundColor: userBubble, color: readableInk(userBubble) }}
            >
              Where is my order?
            </div>
            <p className="text-center text-[9px]" style={{ color: surface.muted }}>
              Sample conversation
            </p>
          </div>

          <div
            className="flex items-center gap-2 px-3 py-2.5"
            style={{ borderTop: `1px solid ${surface.border}` }}
          >
            <span
              className="flex-1 truncate rounded-full px-2.5 py-1.5 text-[10px]"
              style={{ backgroundColor: surface.panel, color: surface.muted }}
            >
              {placeholder}
            </span>
            <span
              aria-hidden="true"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: accent }}
            >
              <span
                className="block h-2 w-2 rotate-45"
                style={{ backgroundColor: readableInk(accent) }}
              />
            </span>
          </div>

          {(draft.showBranding ||
            draft.privacyPolicyUrl ||
            draft.termsUrl) && (
            <div
              className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-[9px]"
              style={{ borderTop: `1px solid ${surface.border}`, color: surface.muted }}
            >
              {draft.privacyPolicyUrl && <span>Privacy</span>}
              {draft.termsUrl && <span>Terms</span>}
              {draft.showBranding && <span className="ml-auto">Powered by AssistIQ</span>}
            </div>
          )}
        </div>
      </div>

      <div className="px-4 py-4">
        <h3 className="text-xs font-medium text-foreground">Bubble colours</h3>
        <dl className="mt-2 space-y-1.5 text-xs">
          <div className="flex items-center gap-2">
            <dt className="flex flex-1 items-center gap-2 text-muted-foreground">
              <span
                aria-hidden="true"
                className="h-3 w-3 rounded-full border border-border"
                style={{ backgroundColor: accent }}
              />
              Accent
            </dt>
            <dd className="text-[10px] tabular-nums text-muted-foreground">{accent}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="flex flex-1 items-center gap-2 text-muted-foreground">
              <span
                aria-hidden="true"
                className="h-3 w-3 rounded-full border border-border"
                style={{ backgroundColor: userBubble }}
              />
              Customer
            </dt>
            <dd className="text-[10px] text-muted-foreground">
              {draft.userBubbleColor ? draft.userBubbleColor : 'Inherits accent'}
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="flex flex-1 items-center gap-2 text-muted-foreground">
              <span
                aria-hidden="true"
                className="h-3 w-3 rounded-full border border-border"
                style={{ backgroundColor: botBubble }}
              />
              Bot
            </dt>
            <dd className="text-[10px] text-muted-foreground">
              {draft.botBubbleColor ? draft.botBubbleColor : 'Surface tone'}
            </dd>
          </div>
        </dl>

        <h3 className="mt-4 text-xs font-medium text-foreground">Deployments</h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {draft.deployments.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              None yet. The Deploy tab creates one.
            </span>
          ) : (
            draft.deployments.map((deployment) => (
              <Badge
                key={deployment.id}
                variant={
                  deployment.status === 'PUBLISHED' && deployment.enabled
                    ? 'success'
                    : 'default'
                }
              >
                {formatLabel(deployment.format)}
              </Badge>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
