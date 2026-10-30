'use client';

import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  CHAT_PREVIEW_SURFACES,
  EXPERIENCE_DEFAULTS,
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

export interface ExperiencePreviewTurn {
  role: 'USER' | 'ASSISTANT';
  content: string;
  /** Captured when the turn was added; shown only when timestamps are on. */
  at: string;
}

interface ExperienceChatSurfaceProps {
  draft: ExperienceResponse;
  fallbacks: ExperienceFallbacks;
  botId: string;
  botName: string;
  avatar: ExperienceAvatar;
  turns: ExperiencePreviewTurn[];
  sending: boolean;
  error: string | null;
  input: string;
  /** Test calls are gated on `bots:manage` server-side, like the configure tab. */
  readOnly: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onChipSelect: (question: string) => void;
}

function now(): string {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export { now as previewTimestamp };

/**
 * The chat itself, drawn from the draft (CP-10.1, CP-10.6, CP-10.7).
 *
 * One surface shared by all three format shells: the header carries the avatar,
 * name and logo; the transcript opens according to `firstOpenBehavior`; bubbles use
 * the accent and bubble colours; the footer carries the policy links and credit.
 * Everything here reads the live draft object, so a colour change in the Design tab
 * is visible the moment the owner switches back — no second fetch.
 *
 * The surfaces are explicit rather than dashboard tokens: a light experience must
 * render light while the owner works in dark mode, and vice versa.
 */
export function ExperienceChatSurface({
  draft,
  fallbacks,
  botId,
  botName,
  avatar,
  turns,
  sending,
  error,
  input,
  readOnly,
  onInputChange,
  onSend,
  onChipSelect,
}: ExperienceChatSurfaceProps) {
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
    draft.inputPlaceholder || fallbacks.inputPlaceholder || 'Type your message…';
  const logo =
    draft.businessLogoUrl && isHttpUrl(draft.businessLogoUrl)
      ? draft.businessLogoUrl
      : null;

  const behavior = draft.firstOpenBehavior;
  const showWelcome = behavior !== 'empty' && turns.length === 0;
  const showChips = behavior === 'welcome' && turns.length === 0;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      style={{ backgroundColor: surface.ground }}
    >
      <div
        className="flex shrink-0 items-center gap-2 px-3 py-2.5"
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
            Online · test preview
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

      <div
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
      >
        {showWelcome ? (
          <div className="flex flex-col items-start gap-1">
            <div
              className="max-w-[85%] rounded-2xl rounded-tl-sm px-2.5 py-2 text-[11px] leading-4"
              style={{
                backgroundColor: botBubble,
                color: readableInk(botBubble),
              }}
            >
              {welcome}
            </div>
            {draft.welcomeSubtitle && (
              <p className="text-[10px]" style={{ color: surface.muted }}>
                {draft.welcomeSubtitle}
              </p>
            )}
            {draft.showTimestamps && (
              <span className="text-[9px]" style={{ color: surface.muted }}>
                {now()}
              </span>
            )}
          </div>
        ) : (
          turns.length === 0 && (
            <p
              className="py-6 text-center text-[11px]"
              style={{ color: surface.muted }}
            >
              Nothing yet — send a message to test this draft.
            </p>
          )
        )}

        {showChips && questions.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {questions.map((question) => (
              <button
                key={question}
                type="button"
                disabled={readOnly}
                onClick={() => onChipSelect(question)}
                className="max-w-full cursor-pointer truncate rounded-full border px-2 py-0.5 text-[10px] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                style={{ borderColor: accent, color: accent }}
              >
                {question}
              </button>
            ))}
          </div>
        )}

        {turns.map((turn, index) =>
          turn.role === 'USER' ? (
            <div key={index} className="flex flex-col items-end gap-0.5">
              <div
                className="max-w-[80%] rounded-2xl rounded-br-sm px-2.5 py-2 text-[11px] leading-4"
                style={{
                  backgroundColor: userBubble,
                  color: readableInk(userBubble),
                }}
              >
                {turn.content}
              </div>
              {draft.showTimestamps && (
                <span className="text-[9px]" style={{ color: surface.muted }}>
                  {turn.at}
                </span>
              )}
            </div>
          ) : (
            <div key={index} className="flex flex-col items-start gap-0.5">
              <div
                className="max-w-[85%] rounded-2xl rounded-tl-sm px-2.5 py-2 text-[11px] leading-4"
                style={{
                  backgroundColor: botBubble,
                  color: readableInk(botBubble),
                }}
              >
                {turn.content}
              </div>
              {draft.showTimestamps && (
                <span className="text-[9px]" style={{ color: surface.muted }}>
                  {turn.at}
                </span>
              )}
            </div>
          ),
        )}

        {sending && (
          <div
            className="flex items-center gap-1.5 text-[11px]"
            style={{ color: surface.muted }}
          >
            <Spinner size="sm" />
            Typing…
          </div>
        )}

        {error && (
          <p role="alert" className="text-[11px] text-destructive">
            {error}
          </p>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
        className="flex shrink-0 items-center gap-2 px-3 py-2.5"
        style={{ borderTop: `1px solid ${surface.border}` }}
      >
        <Input
          id="experience-preview-message"
          aria-label="Test message"
          value={input}
          disabled={sending || readOnly}
          placeholder={readOnly ? 'Read-only' : placeholder}
          onChange={(event) => onInputChange(event.target.value)}
          className="h-8 text-xs"
        />
        <Button
          type="submit"
          size="sm"
          aria-label="Send test message"
          disabled={!input.trim() || sending || readOnly}
          className="h-8 w-8 shrink-0 !px-0"
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
      </form>

      {(draft.showBranding || draft.privacyPolicyUrl || draft.termsUrl) && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-[9px]"
          style={{
            borderTop: `1px solid ${surface.border}`,
            color: surface.muted,
          }}
        >
          {draft.privacyPolicyUrl && <span>Privacy</span>}
          {draft.termsUrl && <span>Terms</span>}
          {draft.showBranding && (
            <span className="ml-auto">Powered by AssistIQ</span>
          )}
        </div>
      )}
    </div>
  );
}
