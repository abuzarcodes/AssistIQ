'use client';

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { ExperienceResponse } from '@/lib/api/experience';
import { ExperienceBehaviorSection } from './experience-behavior-section';
import { ExperienceBrandingSection } from './experience-branding-section';
import { ExperienceLayoutSection } from './experience-layout-section';
import { ExperienceSummaryCard } from './experience-summary-card';
import { ExperienceThemeSection } from './experience-theme-section';
import { ExperienceWelcomeSection } from './experience-welcome-section';
import type {
  ExperienceAvatar,
  ExperienceAvatarChanged,
  ExperienceChange,
  ExperienceFallbacks,
} from './experience-types';
import type { ExperienceErrors } from './experience-validation';

interface ExperienceDesignTabProps {
  draft: ExperienceResponse;
  errors: ExperienceErrors;
  disabled: boolean;
  botId: string;
  botName: string;
  avatar: ExperienceAvatar;
  fallbacks: ExperienceFallbacks;
  onChange: ExperienceChange;
  onAvatarChanged: ExperienceAvatarChanged;
  /** Writes the platform defaults over the draft; saving and publishing remain manual. */
  onReset: () => void;
}

/**
 * The Design tab: everything a business can change about its own chat.
 *
 * One column of sections, in the order a visitor meets the experience — who is
 * speaking, what it looks like, where it sits, what it says, how it behaves — with a
 * sticky summary that answers "did that take?" without leaving the field being edited.
 *
 * Reset is deliberately guarded by a dialog and does not save: the dialog says so, and
 * the draft stays recoverable through Discard until the owner saves.
 */
export function ExperienceDesignTab({
  draft,
  errors,
  disabled,
  botId,
  botName,
  avatar,
  fallbacks,
  onChange,
  onAvatarChanged,
  onReset,
}: ExperienceDesignTabProps) {
  const [resetOpen, setResetOpen] = useState(false);

  function confirmReset() {
    onReset();
    setResetOpen(false);
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            These settings apply to the hosted page, the widget and the embed. Fields
            left empty inherit the value from the bot configuration.
          </p>
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setResetOpen(true)}
              className="shrink-0"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Reset to defaults
            </Button>
          )}
        </div>

        <div className="mt-8 space-y-9">
          <ExperienceBrandingSection
            draft={draft}
            errors={errors}
            disabled={disabled}
            botId={botId}
            botName={botName}
            avatar={avatar}
            fallbacks={fallbacks}
            onChange={onChange}
            onAvatarChanged={onAvatarChanged}
          />
          <ExperienceThemeSection
            draft={draft}
            disabled={disabled}
            onChange={onChange}
          />
          <ExperienceLayoutSection
            draft={draft}
            errors={errors}
            disabled={disabled}
            onChange={onChange}
          />
          <ExperienceWelcomeSection
            draft={draft}
            errors={errors}
            disabled={disabled}
            fallbacks={fallbacks}
            onChange={onChange}
          />
          <ExperienceBehaviorSection
            draft={draft}
            errors={errors}
            disabled={disabled}
            onChange={onChange}
          />
        </div>
      </div>

      <aside className="lg:sticky lg:top-4" aria-label="Experience summary">
        <ExperienceSummaryCard
          draft={draft}
          fallbacks={fallbacks}
          botId={botId}
          botName={botName}
          avatar={avatar}
        />
      </aside>

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset every field to the platform defaults?"
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            This clears the name, colours, layout, welcome copy and behaviour settings
            from this draft and puts the platform defaults back. Your bot avatar is
            untouched, and the live experience does not change until you save and
            publish.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button variant="secondary" size="sm" onClick={confirmReset}>
              Reset fields
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
