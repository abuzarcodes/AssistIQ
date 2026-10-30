import type { ExperienceConfigSnapshot } from '@/lib/api/experience';

/**
 * Experience Studio configuration constants (client mirror).
 *
 * The server owns the defaults and the limits
 * (`app/server/src/constants/experienceDefaults.ts`); this module mirrors them so the
 * editor can render counters, clamp sliders and apply a reset without a round trip.
 * Where the two ever disagree, the server wins: it rejects the save with a 400 and the
 * studio shows that message.
 *
 * The preset palettes are **customer-facing data**, not dashboard design tokens. They
 * describe colours a business may choose for its own chat surface, so they live here in
 * `lib/` rather than in `app/` or `components/`, where the design-token guard would
 * (correctly) reject them.
 */

export const EXPERIENCE_LIMITS = {
  displayName: 60,
  hostedPageTitle: 120,
  hostedPageDescription: 500,
  widgetLauncherLabel: 40,
  widgetPanelWidth: { min: 280, max: 800 },
  widgetPanelHeight: { min: 400, max: 1000 },
  welcomeMessage: 500,
  welcomeSubtitle: 200,
  inputPlaceholder: 120,
  suggestedQuestionsMax: 10,
  suggestedQuestionLength: 120,
  iframeWidth: 20,
  iframeHeight: 20,
  url: 500,
} as const;

/**
 * Every editable field on the draft, in the order the Design tab presents them.
 * The studio's dirty check, patch builder, reset and validation all read this one list,
 * so a new field cannot be added to the schema and forgotten by one of them.
 */
export const EXPERIENCE_CONFIG_KEYS: readonly (keyof ExperienceConfigSnapshot)[] = [
  'displayName',
  'businessLogoUrl',
  'accentColor',
  'userBubbleColor',
  'botBubbleColor',
  'themeMode',
  'themePreset',
  'hostedPageTitle',
  'hostedPageDescription',
  'widgetPosition',
  'widgetLauncherLabel',
  'widgetPanelWidth',
  'widgetPanelHeight',
  'widgetMobileBehavior',
  'iframeWidth',
  'iframeHeight',
  'welcomeMessage',
  'welcomeSubtitle',
  'inputPlaceholder',
  'suggestedQuestions',
  'firstOpenBehavior',
  'showTimestamps',
  'autoOpen',
  'privacyPolicyUrl',
  'termsUrl',
  'showBranding',
];

/** Platform defaults, mirrored from `EXPERIENCE_DEFAULTS`. */
export const EXPERIENCE_DEFAULTS: ExperienceConfigSnapshot = {
  displayName: null,
  botAvatarUrl: null,
  businessLogoUrl: null,
  accentColor: '#ff6b35',
  userBubbleColor: null,
  botBubbleColor: null,
  themeMode: 'system',
  themePreset: null,

  hostedPageTitle: null,
  hostedPageDescription: null,
  widgetPosition: 'bottom-right',
  widgetLauncherLabel: null,
  widgetPanelWidth: 400,
  widgetPanelHeight: 600,
  widgetMobileBehavior: 'fullscreen',
  iframeWidth: '100%',
  iframeHeight: '600px',

  welcomeMessage: null,
  welcomeSubtitle: null,
  inputPlaceholder: null,
  suggestedQuestions: [],
  firstOpenBehavior: 'welcome',

  showTimestamps: true,
  autoOpen: false,
  privacyPolicyUrl: null,
  termsUrl: null,
  showBranding: true,
};

export type ExperiencePresetId = 'minimal' | 'professional' | 'friendly' | 'dark';

export interface ExperienceThemePreset {
  id: ExperiencePresetId;
  name: string;
  description: string;
  accentColor: string;
  userBubbleColor: string | null;
  botBubbleColor: string | null;
  themeMode: 'light' | 'dark' | 'system';
}

/**
 * The four starting points. A preset writes four fields and nothing else; every field
 * stays individually editable afterwards, and the card shows as selected only while the
 * draft still matches it — so an owner can see at a glance that they have customised it.
 */
export const EXPERIENCE_THEME_PRESETS: ExperienceThemePreset[] = [
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Near-black on white. The conversation carries the colour.',
    accentColor: '#111827',
    userBubbleColor: '#111827',
    botBubbleColor: '#f3f4f6',
    themeMode: 'light',
  },
  {
    id: 'professional',
    name: 'Professional',
    description: 'A deep blue for a service desk that has to look composed.',
    accentColor: '#1d4ed8',
    userBubbleColor: '#1d4ed8',
    botBubbleColor: '#eff6ff',
    themeMode: 'light',
  },
  {
    id: 'friendly',
    name: 'Friendly',
    description: 'A warm teal for retail and front-of-house support.',
    accentColor: '#0f766e',
    userBubbleColor: '#0f766e',
    botBubbleColor: '#ecfdf5',
    themeMode: 'light',
  },
  {
    id: 'dark',
    name: 'Dark',
    description: 'The brand orange on a true-neutral dark surface.',
    accentColor: '#ff6b35',
    userBubbleColor: '#ff6b35',
    botBubbleColor: '#262626',
    themeMode: 'dark',
  },
];

/** True while the draft's four themed fields still equal this preset. */
export function matchesPreset(
  preset: ExperienceThemePreset,
  draft: Pick<
    ExperienceConfigSnapshot,
    'accentColor' | 'userBubbleColor' | 'botBubbleColor' | 'themeMode'
  >,
): boolean {
  return (
    normalizeHex(draft.accentColor) === normalizeHex(preset.accentColor) &&
    normalizeHex(draft.userBubbleColor) === normalizeHex(preset.userBubbleColor) &&
    normalizeHex(draft.botBubbleColor) === normalizeHex(preset.botBubbleColor) &&
    draft.themeMode === preset.themeMode
  );
}

/**
 * The customer chat surface, drawn in the summary card.
 *
 * Explicit values rather than the dashboard's tokens: a preview of a light experience
 * must stay light while the owner is working in dark mode, and vice versa.
 */
export const CHAT_PREVIEW_SURFACES = {
  light: {
    ground: '#ffffff',
    panel: '#f5f5f6',
    ink: '#111827',
    muted: '#5f6368',
    border: '#e5e7eb',
  },
  dark: {
    ground: '#111111',
    panel: '#1c1c1e',
    ink: '#f5f5f5',
    muted: '#b4b4b4',
    border: '#2e2e30',
  },
} as const;

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHexColor(value: string | null | undefined): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/** Expand `#abc` to `#aabbcc`; return null for anything that is not a hex colour. */
export function normalizeHex(value: string | null | undefined): string | null {
  if (!isHexColor(value)) return null;
  const hex = value.slice(1).toLowerCase();
  if (hex.length === 6) return `#${hex}`;
  return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
}

/** A valid six-digit hex for a native colour input. */
export function colorInputValue(
  value: string | null | undefined,
  fallback: string,
): string {
  return normalizeHex(value) ?? normalizeHex(fallback) ?? fallback;
}

/** Black or white text, whichever reads on the given bubble colour. */
export function readableInk(background: string | null | undefined): string {
  const hex = normalizeHex(background);
  if (!hex) return CHAT_PREVIEW_SURFACES.light.ink;

  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;

  return luminance > 0.45 ? '#111827' : '#ffffff';
}

/** An absolute http(s) URL, the only kind the privacy, terms and logo fields accept. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A CSS length: `100%`, `600px`, `40rem`, `90vh`. */
export function isCssLength(value: string): boolean {
  return /^\d+(\.\d+)?(px|%|rem|em|vh|vw)$/.test(value.trim());
}
