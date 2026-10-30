'use client';

import { ImageIcon } from 'lucide-react';
import { ColorField } from '@/components/ui/color-field';
import { Input } from '@/components/ui/input';
import {
  CHAT_PREVIEW_SURFACES,
  EXPERIENCE_DEFAULTS,
  EXPERIENCE_LIMITS,
  isHexColor,
  isHttpUrl,
} from '@/lib/experience/config';
import type { ExperienceConfigSnapshot, ExperienceResponse } from '@/lib/api/experience';
import { AvatarUploader } from '../../_components/avatar-uploader';
import { ExperienceSection } from './experience-section';
import type {
  ExperienceAvatar,
  ExperienceAvatarChanged,
  ExperienceChange,
  ExperienceFallbacks,
} from './experience-types';
import type { ExperienceErrors } from './experience-validation';

interface ExperienceBrandingSectionProps {
  draft: ExperienceResponse;
  errors: ExperienceErrors;
  disabled: boolean;
  botId: string;
  botName: string;
  avatar: ExperienceAvatar;
  fallbacks: ExperienceFallbacks;
  onChange: ExperienceChange;
  onAvatarChanged: ExperienceAvatarChanged;
}

/**
 * Branding: the identity a customer meets first — avatar, name, accent and bubbles.
 *
 * The avatar uploads immediately through the bot's existing endpoint (a pending upload
 * behind a save bar loses the file when the owner navigates away); every other field is
 * part of the draft and saves together.
 */
export function ExperienceBrandingSection({
  draft,
  errors,
  disabled,
  botId,
  botName,
  avatar,
  fallbacks,
  onChange,
  onAvatarChanged,
}: ExperienceBrandingSectionProps) {
  const accentFallback = isHexColor(draft.accentColor)
    ? draft.accentColor
    : EXPERIENCE_DEFAULTS.accentColor;
  const logoUrl = draft.businessLogoUrl ?? '';
  const logoPreviewable = logoUrl.trim().length > 0 && isHttpUrl(logoUrl);

  function set<K extends keyof ExperienceConfigSnapshot>(
    field: K,
    value: ExperienceConfigSnapshot[K],
  ) {
    onChange(field, value);
  }

  return (
    <ExperienceSection
      id="experience-branding"
      title="Branding"
      description="The name, avatar and colours customers see in the hosted page, the widget and the embed."
    >
      <div className="rounded-lg border border-border px-3 py-3">
        <AvatarUploader
          botId={botId}
          name={draft.displayName || fallbacks.displayName || botName}
          hasAvatar={avatar.hasAvatar}
          avatarVersion={avatar.avatarVersion}
          disabled={disabled}
          onChanged={onAvatarChanged}
        />
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          Uploads immediately. This avatar is shared with the bot’s other surfaces.
        </p>
      </div>

      <Input
        id="experience-display-name"
        label="Display name"
        value={draft.displayName ?? ''}
        maxLength={EXPERIENCE_LIMITS.displayName}
        disabled={disabled}
        error={errors.displayName}
        placeholder={fallbacks.displayName}
        onChange={(event) => set('displayName', event.target.value || null)}
      />
      <p className="-mt-2 text-xs text-muted-foreground">
        {draft.displayName
          ? 'Customers see this name.'
          : `Customers see ${fallbacks.displayName}.`}
      </p>

      <ColorField
        id="experience-accent-color"
        label="Accent colour"
        value={draft.accentColor}
        fallback={EXPERIENCE_DEFAULTS.accentColor}
        error={errors.accentColor}
        disabled={disabled}
        description="Used for the send button, links and the customer’s own messages unless you set a bubble colour."
        onChange={(value) => set('accentColor', value ?? EXPERIENCE_DEFAULTS.accentColor)}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ColorField
          id="experience-user-bubble"
          label="Customer bubble"
          value={draft.userBubbleColor}
          fallback={accentFallback}
          error={errors.userBubbleColor}
          disabled={disabled}
          clearable
          description="Leave empty to inherit the accent."
          onChange={(value) => set('userBubbleColor', value)}
        />
        <ColorField
          id="experience-bot-bubble"
          label="Bot bubble"
          value={draft.botBubbleColor}
          fallback={CHAT_PREVIEW_SURFACES.light.panel}
          error={errors.botBubbleColor}
          disabled={disabled}
          clearable
          description="Leave empty to use the chat surface tone."
          onChange={(value) => set('botBubbleColor', value)}
        />
      </div>

      <div className="space-y-2">
        <Input
          id="experience-business-logo"
          label="Business logo URL"
          value={logoUrl}
          maxLength={EXPERIENCE_LIMITS.url}
          disabled={disabled}
          error={errors.businessLogoUrl}
          placeholder="https://example.com/logo.png"
          spellCheck={false}
          onChange={(event) => set('businessLogoUrl', event.target.value || null)}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          A publicly reachable image URL. It appears in the chat header beside the
          display name.
        </p>
        {logoPreviewable ? (
          // eslint-disable-next-line @next/next/no-img-element -- an owner-supplied remote URL is not known at build time.
          <img
            src={logoUrl}
            alt="Business logo preview"
            className="h-10 max-w-[180px] rounded-md border border-border bg-background object-contain p-1"
          />
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Paste a URL to preview the logo here.
          </p>
        )}
      </div>
    </ExperienceSection>
  );
}
