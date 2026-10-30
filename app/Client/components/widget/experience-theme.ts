import { useEffect, useState } from 'react';
import {
  CHAT_PREVIEW_SURFACES,
  EXPERIENCE_DEFAULTS,
  isHexColor,
  readableInk,
} from '@/lib/experience/config';
import type { ExperienceConfigSnapshot } from '@/lib/api/experience';

export type ExperienceSurfaceTone = 'light' | 'dark';

export interface ExperienceChatColors {
  tone: ExperienceSurfaceTone;
  ground: string;
  panel: string;
  ink: string;
  muted: string;
  border: string;
  accent: string;
  accentInk: string;
  userBubble: string;
  userInk: string;
  botBubble: string;
  botInk: string;
}

/** Resolve `system` against the visitor's device; safe before hydration. */
export function resolveExperienceTone(mode: string): ExperienceSurfaceTone {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return 'light';
}

/**
 * The visitor's theme, kept in step with their OS setting while `system` is on.
 *
 * Fixed modes need no subscription and are returned straight from render. The
 * `system` value is read during render (safe before hydration — it defaults to
 * light) and a tick state re-renders on OS changes. No effect writes state
 * synchronously; the subscription callback is the only writer.
 *
 * The dashboard's own dark mode must not leak into the customer chat: a light
 * experience renders light even for an owner previewing at night, and vice versa.
 */
export function useExperienceTone(mode: string): ExperienceSurfaceTone {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (mode !== 'system' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setTick((current) => current + 1);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [mode]);

  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  // `tick` is never read — its only job is re-rendering on OS theme changes, at
  // which point the live `matchMedia` read below picks up the new value.
  void tick;
  return resolveExperienceTone(mode);
}

/**
 * Every colour the customer chat paints, derived from the published snapshot.
 *
 * The snapshot is server-validated, so the accent is always a real hex value; the
 * fallbacks mirror the Design tab's summary exactly (accent for the customer's
 * bubbles, the surface tone for the bot's).
 */
export function experienceChatColors(
  config: ExperienceConfigSnapshot,
  tone: ExperienceSurfaceTone,
): ExperienceChatColors {
  const surface = CHAT_PREVIEW_SURFACES[tone];
  const accent = isHexColor(config.accentColor)
    ? config.accentColor
    : EXPERIENCE_DEFAULTS.accentColor;
  const userBubble = isHexColor(config.userBubbleColor)
    ? (config.userBubbleColor as string)
    : accent;
  const botBubble = isHexColor(config.botBubbleColor)
    ? (config.botBubbleColor as string)
    : surface.panel;

  return {
    tone,
    ground: surface.ground,
    panel: surface.panel,
    ink: surface.ink,
    muted: surface.muted,
    border: surface.border,
    accent,
    accentInk: readableInk(accent),
    userBubble,
    userInk: readableInk(userBubble),
    botBubble,
    botInk: readableInk(botBubble),
  };
}
