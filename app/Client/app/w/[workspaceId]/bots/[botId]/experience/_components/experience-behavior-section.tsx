'use client';

import { AlertTriangle } from 'lucide-react';
import { CardRadioGroup } from '@/components/ui/card-radio-group';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { EXPERIENCE_LIMITS } from '@/lib/experience/config';
import type {
  ExperienceResponse,
  FirstOpenBehavior,
} from '@/lib/api/experience';
import { ExperienceSection } from './experience-section';
import type { ExperienceChange } from './experience-types';
import type { ExperienceErrors } from './experience-validation';

interface ExperienceBehaviorSectionProps {
  draft: ExperienceResponse;
  errors: ExperienceErrors;
  disabled: boolean;
  onChange: ExperienceChange;
}

const FIRST_OPEN_OPTIONS: {
  value: FirstOpenBehavior;
  label: string;
  description: string;
}[] = [
  {
    value: 'welcome',
    label: 'Welcome screen',
    description: 'The welcome message and suggested questions, before the first message.',
  },
  {
    value: 'prompt',
    label: 'Straight to the input',
    description: 'A short greeting and a focused message box.',
  },
  {
    value: 'empty',
    label: 'Empty conversation',
    description: 'No greeting; the visitor writes first.',
  },
];

/** One labelled switch with a sentence about what it changes. */
function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <Switch
        label={label}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-0.5"
      />
    </div>
  );
}

/** A widget that opens itself is a support tool, not a pop-up ad — say so plainly. */
function AutoOpenWarning() {
  return (
    <div
      role="note"
      className="flex gap-2 rounded-lg border border-warning-bg bg-warning-bg/60 px-3 py-2.5"
    >
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-warning-bg-foreground"
      />
      <p className="text-xs leading-5 text-warning-bg-foreground">
        Opening the chat without a click interrupts whatever the visitor was doing. It is
        off by default and works best on a page whose whole purpose is support.
      </p>
    </div>
  );
}

/**
 * Chat behavior: what happens on first open, and the small policies around the
 * conversation.
 *
 * The first-open choice is cards rather than a segmented control because the
 * difference between the three is visual, not lexical — "welcome" and "prompt" are
 * indistinguishable as words but obviously different as screens.
 */
export function ExperienceBehaviorSection({
  draft,
  errors,
  disabled,
  onChange,
}: ExperienceBehaviorSectionProps) {
  return (
    <ExperienceSection
      id="experience-behavior"
      title="Chat behavior"
      description="How the conversation opens, what it shows, and the links and credit it carries."
    >
      <div className="space-y-2">
        <span className="block text-sm font-medium text-foreground">
          When the chat opens
        </span>
        <CardRadioGroup<FirstOpenBehavior>
          label="First open behavior"
          value={draft.firstOpenBehavior as FirstOpenBehavior}
          columns={3}
          disabled={disabled}
          options={FIRST_OPEN_OPTIONS.map((option) => ({
            ...option,
            preview: <FirstOpenPreview behavior={option.value} />,
          }))}
          onChange={(value) => onChange('firstOpenBehavior', value)}
        />
      </div>

      <div className="divide-y divide-border rounded-lg border border-border px-3 py-1">
        <ToggleRow
          label="Show timestamps"
          description="Prints the time beside each message. Useful for support logs, noise for quick questions."
          checked={draft.showTimestamps}
          disabled={disabled}
          onChange={(value) => onChange('showTimestamps', value)}
        />
        <ToggleRow
          label="Open automatically"
          description="Opens the widget when the page loads instead of waiting for a click."
          checked={draft.autoOpen}
          disabled={disabled}
          onChange={(value) => onChange('autoOpen', value)}
        />
        {draft.autoOpen && <div className="py-3"><AutoOpenWarning /></div>}
        <ToggleRow
          label="Show AssistIQ branding"
          description="A small “Powered by AssistIQ” line at the foot of the chat. Turning it off leaves more room for your own name."
          checked={draft.showBranding}
          disabled={disabled}
          onChange={(value) => onChange('showBranding', value)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          id="experience-privacy-url"
          label="Privacy policy URL"
          value={draft.privacyPolicyUrl ?? ''}
          maxLength={EXPERIENCE_LIMITS.url}
          disabled={disabled}
          error={errors.privacyPolicyUrl}
          placeholder="https://example.com/privacy"
          spellCheck={false}
          inputMode="url"
          onChange={(event) =>
            onChange('privacyPolicyUrl', event.target.value || null)
          }
        />
        <Input
          id="experience-terms-url"
          label="Terms URL"
          value={draft.termsUrl ?? ''}
          maxLength={EXPERIENCE_LIMITS.url}
          disabled={disabled}
          error={errors.termsUrl}
          placeholder="https://example.com/terms"
          spellCheck={false}
          inputMode="url"
          onChange={(event) => onChange('termsUrl', event.target.value || null)}
        />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Both links appear in the chat footer. Leave one empty and it is not shown.
      </p>
    </ExperienceSection>
  );
}

/** A miniature of the first screen each choice produces. Decorative. */
function FirstOpenPreview({ behavior }: { behavior: FirstOpenBehavior }) {
  return (
    <span className="flex h-16 flex-col justify-between gap-1 overflow-hidden rounded-lg border border-border bg-background p-2">
      {behavior !== 'empty' && (
        <>
          <span className="h-1.5 w-14 rounded-full bg-foreground/70" />
          <span className="h-1 w-20 rounded-full bg-border" />
        </>
      )}
      {behavior === 'welcome' && (
        <span className="flex flex-wrap gap-1">
          <span className="h-2 w-8 rounded-full bg-muted" />
          <span className="h-2 w-10 rounded-full bg-muted" />
        </span>
      )}
      {behavior === 'empty' && (
        <span className="flex flex-1 items-center justify-center text-[10px] text-muted-foreground">
          Nothing yet
        </span>
      )}
      <span className="flex items-center gap-1 rounded-full border border-border px-2 py-1">
        <span className="h-1 w-12 rounded-full bg-border" />
        <span className="ml-auto h-2 w-2 rounded-full bg-foreground/40" />
      </span>
    </span>
  );
}
