'use client';

import { RadioGroup } from '@/components/ui/radio-group';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/field';
import { LIMITS, LANGUAGE_OPTIONS, PERSONALITY_OPTIONS, TONE_OPTIONS } from './config-options';
import type { TabProps } from './tab-props';

/**
 * Personality & instructions (plan §7, §16.1).
 *
 * The owner instructions are the lowest-priority prompt block, fenced and permanently
 * subordinated to AssistIQ's core rules. The character counter and the sentinel rejection
 * are the client half of that guarantee; the server is the authority.
 */
export function PersonalityTab({ config, update, disabled }: TabProps) {
  const instructions = config.personality.customInstructions ?? '';
  const containsSentinel = instructions.toUpperCase().includes('INSUFFICIENT_INFORMATION');

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-5">
        <RadioGroup
          name="personality"
          label="Personality"
          orientation="vertical"
          value={config.personality.preset}
          disabled={disabled}
          onChange={(preset) => update('personality', { preset })}
          options={PERSONALITY_OPTIONS}
        />

        {config.personality.preset === 'CUSTOM' && (
          <Textarea
            id="custom-personality"
            label="Describe the personality"
            value={config.personality.customPersonality ?? ''}
            disabled={disabled}
            maxLength={LIMITS.customPersonality}
            placeholder="e.g. A patient teacher who explains step by step."
            onChange={(e) =>
              update('personality', { customPersonality: e.target.value || null })
            }
          />
        )}

        <RadioGroup
          name="tone"
          label="Tone"
          value={config.personality.tone}
          disabled={disabled}
          onChange={(tone) => update('personality', { tone })}
          options={TONE_OPTIONS}
        />

        <Select
          id="response-language"
          label="Response language"
          value={config.personality.responseLanguage}
          disabled={disabled}
          onChange={(e) => update('personality', { responseLanguage: e.target.value })}
          options={LANGUAGE_OPTIONS}
        />
      </div>

      <div className="space-y-4">
        <Field
          htmlFor="custom-instructions"
          label="Custom instructions"
          hint="Additional guidance for the assistant. These refine style and scope — they never override AssistAI’s safety and grounding rules."
          error={containsSentinel ? 'Instructions cannot contain the reserved word INSUFFICIENT_INFORMATION.' : undefined}
          counter={{ current: instructions.length, max: LIMITS.customInstructions }}
        >
          <Textarea
            id="custom-instructions"
            value={instructions}
            disabled={disabled}
            maxLength={LIMITS.customInstructions}
            placeholder="e.g. Always mention our 30-day return window when asked about refunds."
            onChange={(e) =>
              update('personality', { customInstructions: e.target.value || null })
            }
          />
        </Field>
      </div>
    </div>
  );
}