'use client';

import { useState } from 'react';
import { MessageCircle, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RadioGroup } from '@/components/ui/radio-group';
import { ApiError } from '@/lib/api-client';
import {
  previewBotConfig,
  type ResolvedBotConfig,
} from '@/lib/api/botConfig';
import {
  CHAT_PREVIEW_SURFACES,
  EXPERIENCE_DEFAULTS,
  isHexColor,
  readableInk,
} from '@/lib/experience/config';
import type {
  ExperienceResponse,
  ExperienceThemeMode,
  WidgetMobileBehavior,
  WidgetPosition,
} from '@/lib/api/experience';
import {
  ExperienceChatSurface,
  previewTimestamp,
  type ExperiencePreviewTurn,
} from './experience-chat-surface';
import type {
  ExperienceAvatar,
  ExperienceFallbacks,
} from './experience-types';

interface ExperiencePreviewTabProps {
  draft: ExperienceResponse;
  fallbacks: ExperienceFallbacks;
  botId: string;
  botName: string;
  avatar: ExperienceAvatar;
  /** The bot's saved configuration draft, used only for generating test answers. */
  aiDraft: ResolvedBotConfig;
  /** Test calls are gated on `bots:manage` server-side, like the configure tab. */
  readOnly: boolean;
}

type PreviewDevice = 'desktop' | 'mobile';
type PreviewFormat = 'hosted' | 'widget' | 'iframe';

/** The outer frame each device draws around the preview. */
const DEVICE_FRAMES: Record<PreviewDevice, { label: string; width: number; height: number }> = {
  desktop: { label: 'Desktop · 400 by 600', width: 400, height: 600 },
  mobile: { label: 'Mobile · 375 by 667', width: 375, height: 667 },
};

const POSITION_CLASSES: Record<WidgetPosition, string> = {
  'bottom-right': 'justify-end items-end',
  'bottom-left': 'justify-start items-end',
  'top-right': 'justify-end items-start',
  'top-left': 'justify-start items-start',
};

/**
 * The Preview tab (CP-10.1 – CP-10.11).
 *
 * One chat surface in three shells. The toolbar picks a device width and a format;
 * the stage renders the draft as a hosted page, a floating widget or an iframe; the
 * input inside the chat sends a test message through the bot's existing preview
 * endpoint. The transcript, the device and the format are local state — switching
 * them never touches the draft, and the draft is never saved by previewing.
 *
 * The layout answers CP-10.10: on extra-wide screens the stage sits beside a rail
 * naming exactly what is being previewed; below that they stack.
 */
export function ExperiencePreviewTab({
  draft,
  fallbacks,
  botId,
  botName,
  avatar,
  aiDraft,
  readOnly,
}: ExperiencePreviewTabProps) {
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [format, setFormat] = useState<PreviewFormat>('hosted');
  const [turns, setTurns] = useState<ExperiencePreviewTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The widget respects the draft's auto-open setting: a panel that opens itself in
  // production opens itself here too. The tab remounts on every open, so this
  // initial value is always read from the current draft; toggling afterwards is
  // the owner's manual preview control.
  const [widgetOpen, setWidgetOpen] = useState(draft.autoOpen);

  const frame = DEVICE_FRAMES[device];

  async function send() {
    const message = input.trim();
    if (!message || sending || readOnly) return;

    setInput('');
    setError(null);
    setTurns((previous) => [
      ...previous,
      { role: 'USER', content: message, at: previewTimestamp() },
    ]);
    setSending(true);

    try {
      const result = await previewBotConfig(botId, message, aiDraft);
      setTurns((previous) => [
        ...previous,
        {
          role: 'ASSISTANT',
          content: result.response,
          at: previewTimestamp(),
        },
      ]);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'The test could not reach the assistant. Please try again.',
      );
    } finally {
      setSending(false);
    }
  }

  function resetConversation() {
    setTurns([]);
    setInput('');
    setError(null);
  }

  const surfaceProps = {
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
    onInputChange: setInput,
    onSend: () => void send(),
    onChipSelect: (question: string) => setInput(question),
  };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="flex flex-wrap gap-x-8 gap-y-4">
          <RadioGroup<PreviewDevice>
            name="experience-preview-device"
            label="Device"
            value={device}
            options={[
              { value: 'desktop', label: 'Desktop' },
              { value: 'mobile', label: 'Mobile' },
            ]}
            onChange={setDevice}
          />
          <RadioGroup<PreviewFormat>
            name="experience-preview-format"
            label="Format"
            value={format}
            options={[
              { value: 'hosted', label: 'Hosted page' },
              { value: 'widget', label: 'Widget' },
              { value: 'iframe', label: 'Iframe' },
            ]}
            onChange={setFormat}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{frame.label}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={turns.length === 0 && !error}
            onClick={resetConversation}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Reset conversation
          </Button>
        </div>
      </div>

      {readOnly && (
        <p className="mt-4 rounded-lg border border-border bg-muted px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
          Previewing needs bot management access. The chat below still reflects the
          draft; only sending a test message is disabled.
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_280px] xl:items-start">
        <div className="flex min-w-0 justify-center rounded-xl border border-border bg-muted/40 px-4 py-6">
          <div
            role="region"
            aria-label={`Chat preview, ${format}, ${frame.label}`}
            className="w-full overflow-hidden rounded-xl border border-border bg-card"
            style={{ maxWidth: frame.width, height: frame.height }}
          >
            {format === 'hosted' && (
              <HostedShell draft={draft} fallbacks={fallbacks}>
                <ExperienceChatSurface {...surfaceProps} />
              </HostedShell>
            )}
            {format === 'widget' && (
              <WidgetShell
                draft={draft}
                device={device}
                frameWidth={frame.width}
                frameHeight={frame.height}
                open={widgetOpen}
                onToggle={() => setWidgetOpen((open) => !open)}
              >
                <ExperienceChatSurface {...surfaceProps} />
              </WidgetShell>
            )}
            {format === 'iframe' && (
              <IframeShell draft={draft}>
                <ExperienceChatSurface {...surfaceProps} />
              </IframeShell>
            )}
          </div>
        </div>

        <aside
          aria-label="What this preview shows"
          className="rounded-xl border border-border bg-card px-4 py-4"
        >
          <h3 className="text-sm font-semibold text-foreground">
            What you are previewing
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            The unsaved draft, exactly as the Design tab has it.
          </p>
          <PreviewFacts draft={draft} fallbacks={fallbacks} botName={botName} />
          <div className="mt-4 rounded-lg bg-muted px-3 py-2.5">
            <p className="text-xs font-medium text-foreground">Test activity</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Test messages use the bot preview endpoint. Nothing is saved, no
              conversation is created, and nothing counts towards analytics.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** The small facts that prove the preview is reading the draft. */
function PreviewFacts({
  draft,
  fallbacks,
  botName,
}: {
  draft: ExperienceResponse;
  fallbacks: ExperienceFallbacks;
  botName: string;
}) {
  const accent = isHexColor(draft.accentColor)
    ? draft.accentColor
    : EXPERIENCE_DEFAULTS.accentColor;
  const mode = draft.themeMode as ExperienceThemeMode;

  const rows: [string, string][] = [
    ['Name', draft.displayName || fallbacks.displayName || botName],
    ['Accent', accent],
    [
      'Theme',
      mode === 'light' ? 'Light' : mode === 'dark' ? 'Dark' : 'System',
    ],
    ['Opens with', firstOpenLabel(draft.firstOpenBehavior)],
  ];

  if (draft.hostedPageTitle) rows.push(['Page title', draft.hostedPageTitle]);
  rows.push([
    'Widget',
    `${positionLabel(draft.widgetPosition as WidgetPosition)} · ${draft.widgetPanelWidth} by ${draft.widgetPanelHeight}`,
  ]);
  rows.push([
    'Iframe',
    `${draft.iframeWidth} by ${draft.iframeHeight}`,
  ]);

  return (
    <dl className="mt-3 space-y-2 text-xs">
      {rows.map(([term, value]) => (
        <div key={term} className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-muted-foreground">{term}</dt>
          <dd className="min-w-0 truncate text-right font-medium text-foreground">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function firstOpenLabel(behavior: string): string {
  if (behavior === 'prompt') return 'Short greeting';
  if (behavior === 'empty') return 'Empty';
  return 'Welcome screen';
}

function positionLabel(position: WidgetPosition): string {
  if (position === 'bottom-left') return 'Bottom left';
  if (position === 'top-right') return 'Top right';
  if (position === 'top-left') return 'Top left';
  return 'Bottom right';
}

/** Hosted page: the optional title and description above a full-height chat. */
function HostedShell({
  draft,
  fallbacks,
  children,
}: {
  draft: ExperienceResponse;
  fallbacks: ExperienceFallbacks;
  children: React.ReactNode;
}) {
  const title = draft.hostedPageTitle;
  const description = draft.hostedPageDescription;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(title || description) && (
        <div className="shrink-0 px-4 pb-2 pt-4 text-center">
          {title ? (
            <p className="text-sm font-semibold text-foreground">{title}</p>
          ) : (
            <p className="text-sm font-semibold text-muted-foreground">
              {fallbacks.displayName}
            </p>
          )}
          {description && (
            <p className="mx-auto mt-1 max-w-prose text-[11px] leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 px-3 pb-3">{children}</div>
    </div>
  );
}

/**
 * Widget: a host page with a launcher in the configured corner. The panel opens
 * over it at the draft's dimensions (clamped to the frame) on desktop, or per the
 * mobile behaviour on the phone frame.
 */
function WidgetShell({
  draft,
  device,
  frameWidth,
  frameHeight,
  open,
  onToggle,
  children,
}: {
  draft: ExperienceResponse;
  device: PreviewDevice;
  frameWidth: number;
  frameHeight: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const mode = draft.themeMode as ExperienceThemeMode;
  const tone = mode === 'dark' ? 'dark' : 'light';
  const surface = CHAT_PREVIEW_SURFACES[tone];
  const accent = isHexColor(draft.accentColor)
    ? draft.accentColor
    : EXPERIENCE_DEFAULTS.accentColor;
  const position = draft.widgetPosition as WidgetPosition;
  const mobile = draft.widgetMobileBehavior as WidgetMobileBehavior;
  const label = draft.widgetLauncherLabel || 'Chat with us';

  // Desktop: the panel floats in the configured corner at the draft's pixel size,
  // clamped so it always fits the frame. Phone: the mobile behaviour decides —
  // full screen, a centred modal or a bottom sheet.
  const panelStyle =
    device === 'desktop'
      ? {
          width: Math.min(draft.widgetPanelWidth, frameWidth - 24),
          height: Math.min(draft.widgetPanelHeight, frameHeight - 24),
          ...(position.includes('right') ? { right: 12 } : { left: 12 }),
          ...(position.includes('bottom') ? { bottom: 12 } : { top: 12 }),
          position: 'absolute' as const,
        }
      : mobile === 'fullscreen'
        ? { inset: 0, position: 'absolute' as const }
        : mobile === 'modal'
          ? { inset: '24px 16px', position: 'absolute' as const }
          : {
              left: 0,
              right: 0,
              bottom: 0,
              height: '62%',
              position: 'absolute' as const,
            };

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ backgroundColor: surface.panel }}
    >
      <p
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-4 text-center text-[11px]"
        style={{ color: surface.muted }}
      >
        Host page
      </p>

      {open ? (
        <div
          className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-xl border"
          style={{
            borderColor: surface.border,
            backgroundColor: surface.ground,
            ...panelStyle,
          }}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-label="Close chat preview"
            className="absolute right-2 top-2 z-10 cursor-pointer rounded-full p-1 transition-opacity hover:opacity-70"
            style={{ color: surface.muted }}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {children}
        </div>
      ) : (
        <div className={`absolute inset-3 flex ${POSITION_CLASSES[position]}`}>
          <button
            type="button"
            onClick={onToggle}
            aria-label="Open chat preview"
            className="flex cursor-pointer items-center gap-2 rounded-full py-2.5 pl-3 pr-4 text-xs font-medium shadow-lg transition-opacity hover:opacity-90"
            style={{
              backgroundColor: accent,
              color: readableInk(accent),
            }}
          >
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        </div>
      )}
    </div>
  );
}

/** Iframe: a browser frame naming the embed dimensions, with the chat inside. */
function IframeShell({
  draft,
  children,
}: {
  draft: ExperienceResponse;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span aria-hidden="true" className="flex gap-1">
          <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
          <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
          <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          Embed · {draft.iframeWidth} by {draft.iframeHeight}
        </span>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
