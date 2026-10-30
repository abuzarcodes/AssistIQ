'use client';

import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  EXPERIENCE_DEFAULTS,
  EXPERIENCE_LIMITS,
  isHexColor,
} from '@/lib/experience/config';
import type { ExperienceResponse } from '@/lib/api/experience';
import { ExperienceQuestionsEditor } from './experience-questions-editor';
import { ExperienceSection } from './experience-section';
import type { ExperienceChange, ExperienceFallbacks } from './experience-types';
import type { ExperienceErrors } from './experience-validation';

interface ExperienceWelcomeSectionProps {
  draft: ExperienceResponse;
  errors: ExperienceErrors;
  disabled: boolean;
  fallbacks: ExperienceFallbacks;
  onChange: ExperienceChange;
}

/**
 * A faded line naming the value the customer would currently see. Shown only when the
 * field is empty, which is what makes "inherit" visible rather than merely possible.
 */
function FallbackHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs leading-5 text-muted-foreground">
      <span className="font-medium">Inherited:</span> {children}
    </p>
  );
}

/**
 * Welcome: the first screen of the conversation.
 *
 * Every field here falls back to the bot configuration when empty, so an owner can
 * change one sentence without restating the rest. The inherited value is printed under
 * the empty control — a placeholder alone disappears the moment someone types, and the
 * owner then has no way back to seeing what they replaced.
 */
export function ExperienceWelcomeSection({
  draft,
  errors,
  disabled,
  fallbacks,
  onChange,
}: ExperienceWelcomeSectionProps) {
  const accent = isHexColor(draft.accentColor)
    ? draft.accentColor
    : EXPERIENCE_DEFAULTS.accentColor;

  return (
    <ExperienceSection
      id="experience-welcome"
      title="Welcome"
      description="The first thing a customer reads, and the questions they can start from. Empty fields keep the bot configuration’s copy."
    >
      <div className="space-y-1.5">
        <Textarea
          id="experience-welcome-message"
          label="Welcome message"
          value={draft.welcomeMessage ?? ''}
          maxLength={EXPERIENCE_LIMITS.welcomeMessage}
          disabled={disabled}
          error={errors.welcomeMessage}
          placeholder={
            fallbacks.welcomeMessage ??
            'Use the welcome message from the bot configuration'
          }
          onChange={(event) =>
            onChange('welcomeMessage', event.target.value || null)
          }
        />
        {draft.welcomeMessage ? (
          <p className="text-xs text-muted-foreground">
            {draft.effective.isWelcomeMessageOverridden
              ? 'Customers see the message written here.'
              : 'Customers currently see the bot configuration’s welcome message.'}
          </p>
        ) : (
          <FallbackHint>
            {fallbacks.welcomeMessage
              ? `“${fallbacks.welcomeMessage}”`
              : 'No welcome message is configured for this bot yet.'}
          </FallbackHint>
        )}
      </div>

      <Input
        id="experience-welcome-subtitle"
        label="Subtitle"
        value={draft.welcomeSubtitle ?? ''}
        maxLength={EXPERIENCE_LIMITS.welcomeSubtitle}
        disabled={disabled}
        error={errors.welcomeSubtitle}
        placeholder="A second line under the welcome message"
        onChange={(event) =>
          onChange('welcomeSubtitle', event.target.value || null)
        }
      />

      <div className="space-y-1.5">
        <Input
          id="experience-input-placeholder"
          label="Input placeholder"
          value={draft.inputPlaceholder ?? ''}
          maxLength={EXPERIENCE_LIMITS.inputPlaceholder}
          disabled={disabled}
          error={errors.inputPlaceholder}
          placeholder={fallbacks.inputPlaceholder ?? 'Type your message…'}
          onChange={(event) =>
            onChange('inputPlaceholder', event.target.value || null)
          }
        />
        {!draft.inputPlaceholder && (
          <FallbackHint>
            {fallbacks.inputPlaceholder
              ? `“${fallbacks.inputPlaceholder}”`
              : 'The chat uses its own default placeholder.'}
          </FallbackHint>
        )}
      </div>

      <div className="space-y-1.5">
        <ExperienceQuestionsEditor
          value={draft.suggestedQuestions}
          fallback={fallbacks.suggestedQuestions}
          disabled={disabled}
          onChange={(value) => onChange('suggestedQuestions', value)}
        />
        {errors.suggestedQuestions && (
          <p role="alert" className="text-xs text-destructive">
            {errors.suggestedQuestions}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2.5">
        <span
          aria-hidden="true"
          className="h-5 w-5 shrink-0 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          The accent colour you chose in Branding paints the question chips and the send
          button on this screen.
        </p>
      </div>
    </ExperienceSection>
  );
}
