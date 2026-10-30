'use client';

import { CardRadioGroup } from '@/components/ui/card-radio-group';
import {
  CHAT_PREVIEW_SURFACES,
  EXPERIENCE_THEME_PRESETS,
  matchesPreset,
  type ExperiencePresetId,
} from '@/lib/experience/config';
import type {
  ExperienceResponse,
  ExperienceThemeMode,
} from '@/lib/api/experience';
import { ExperienceSection } from './experience-section';
import type { ExperienceChange } from './experience-types';

interface ExperienceThemeSectionProps {
  draft: ExperienceResponse;
  disabled: boolean;
  onChange: ExperienceChange;
}

const MODE_OPTIONS: {
  value: ExperienceThemeMode;
  label: string;
  description: string;
}[] = [
  {
    value: 'light',
    label: 'Light',
    description: 'A white surface, whatever the visitor’s device prefers.',
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'A dark surface, whatever the visitor’s device prefers.',
  },
  {
    value: 'system',
    label: 'System',
    description: 'Follows each visitor’s device setting.',
  },
];

/** A miniature of the chat surface in one tone. Decorative; the label carries meaning. */
function SurfacePreview({
  tone,
  accent,
  className = '',
}: {
  tone: 'light' | 'dark';
  accent: string;
  className?: string;
}) {
  const surface = CHAT_PREVIEW_SURFACES[tone];

  return (
    <span
      className={`flex flex-col gap-1.5 overflow-hidden rounded-lg border p-2 ${className}`}
      style={{ backgroundColor: surface.ground, borderColor: surface.border }}
    >
      <span className="flex items-center gap-1.5">
        <span
          className="h-4 w-4 rounded-full"
          style={{ backgroundColor: surface.panel }}
        />
        <span
          className="h-1.5 w-12 rounded-full"
          style={{ backgroundColor: surface.ink, opacity: 0.8 }}
        />
      </span>
      <span
        className="mt-1 h-1 w-3/4 rounded-full"
        style={{ backgroundColor: surface.muted, opacity: 0.5 }}
      />
      <span
        className="h-1 w-1/2 rounded-full"
        style={{ backgroundColor: surface.muted, opacity: 0.35 }}
      />
      <span
        className="mt-auto ml-auto block h-3 w-10 rounded-full"
        style={{ backgroundColor: accent }}
      />
    </span>
  );
}

function ThemeModePreview({
  mode,
  accent,
}: {
  mode: ExperienceThemeMode;
  accent: string;
}) {
  if (mode === 'system') {
    return (
      <span className="grid grid-cols-2 gap-1">
        <SurfacePreview tone="light" accent={accent} className="h-16" />
        <SurfacePreview tone="dark" accent={accent} className="h-16" />
      </span>
    );
  }

  return (
    <span className="block">
      <SurfacePreview tone={mode} accent={accent} className="h-16" />
    </span>
  );
}

/** The preset's three colours as the chat actually uses them. */
function PresetPreview({
  accent,
  userBubble,
  botBubble,
}: {
  accent: string;
  userBubble: string;
  botBubble: string;
}) {
  return (
    <span className="flex h-16 flex-col justify-center gap-1.5 overflow-hidden rounded-lg border border-border bg-background p-2">
      <span className="flex items-center gap-1.5">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span
          className="h-1.5 w-10 rounded-full"
          style={{ backgroundColor: accent, opacity: 0.35 }}
        />
      </span>
      <span className="flex justify-end">
        <span
          className="h-3.5 w-16 rounded-full"
          style={{ backgroundColor: botBubble }}
        />
      </span>
      <span className="flex justify-start">
        <span
          className="h-3.5 w-12 rounded-full"
          style={{ backgroundColor: userBubble }}
        />
      </span>
    </span>
  );
}

/**
 * Theme: the surface mode and the four starting palettes.
 *
 * A preset writes accent, both bubbles and the mode. It is a starting point, not a lock:
 * every field stays editable, and the card only reads as selected while the draft still
 * matches it — so a customised palette shows honestly as custom.
 */
export function ExperienceThemeSection({
  draft,
  disabled,
  onChange,
}: ExperienceThemeSectionProps) {
  const activePreset =
    EXPERIENCE_THEME_PRESETS.find((preset) => matchesPreset(preset, draft))?.id ??
    null;

  const accent = draft.accentColor;

  function applyPreset(id: ExperiencePresetId) {
    const preset = EXPERIENCE_THEME_PRESETS.find((entry) => entry.id === id);
    if (!preset) return;

    onChange('accentColor', preset.accentColor);
    onChange('userBubbleColor', preset.userBubbleColor);
    onChange('botBubbleColor', preset.botBubbleColor);
    onChange('themeMode', preset.themeMode);
    onChange('themePreset', preset.id);
  }

  return (
    <ExperienceSection
      id="experience-theme"
      title="Theme"
      description="The surface the conversation sits on, and a palette to start from."
    >
      <div className="space-y-2">
        <span className="block text-sm font-medium text-foreground">Mode</span>
        <CardRadioGroup<ExperienceThemeMode>
          label="Theme mode"
          value={draft.themeMode as ExperienceThemeMode}
          columns={3}
          disabled={disabled}
          options={MODE_OPTIONS.map((option) => ({
            ...option,
            preview: (
              <ThemeModePreview mode={option.value} accent={accent} />
            ),
          }))}
          onChange={(value) => onChange('themeMode', value)}
        />
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-foreground">
            Starting palette
          </span>
          {activePreset === null && (
            <span className="text-xs text-muted-foreground">
              Custom colours in use
            </span>
          )}
        </div>
        <CardRadioGroup<ExperiencePresetId>
          label="Starting palette"
          value={activePreset}
          columns={4}
          disabled={disabled}
          options={EXPERIENCE_THEME_PRESETS.map((preset) => ({
            value: preset.id,
            label: preset.name,
            description: preset.description,
            preview: (
              <PresetPreview
                accent={preset.accentColor}
                userBubble={preset.userBubbleColor ?? preset.accentColor}
                botBubble={preset.botBubbleColor ?? CHAT_PREVIEW_SURFACES.light.panel}
              />
            ),
          }))}
          onChange={applyPreset}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          A preset fills the accent, both bubble colours and the mode. Change any of
          them afterwards and your values stay as you set them.
        </p>
      </div>
    </ExperienceSection>
  );
}
