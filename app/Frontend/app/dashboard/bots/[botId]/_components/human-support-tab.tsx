'use client';

import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup } from '@/components/ui/radio-group';
import { BusinessHoursEditor } from './business-hours-editor';
import { ContactFieldsEditor } from './contact-fields-editor';
import { HUMAN_REQUEST_OPTIONS, LIMITS } from './config-options';
import type { TabProps } from './tab-props';

/**
 * Human support (plan §14). The fallback toggle, the owner's fallback copy, explicit
 * human-request behaviour, the handoff line, business hours and contact collection.
 *
 * The platform-fault copy (`MODEL_UNAVAILABLE` et al.) is never rewordable here, which is
 * why the fallback message is described as applying only when the bot cannot answer.
 */
export function HumanSupportTab({ config, update, disabled }: TabProps) {
  const support = config.humanSupport;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-5">
        <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
          <div>
            <span className="text-sm font-medium text-foreground">Human fallback</span>
            <p className="text-xs text-muted-foreground">
              Escalate to a human when the bot cannot answer.
            </p>
          </div>
          <Switch
            label="Human fallback"
            checked={support.fallbackEnabled}
            disabled={disabled}
            onChange={(fallbackEnabled) => update('humanSupport', { fallbackEnabled })}
          />
        </div>

        {support.fallbackEnabled && (
          <Textarea
            id="fallback-message"
            label="Fallback message"
            value={support.fallbackMessage ?? ''}
            disabled={disabled}
            maxLength={LIMITS.fallbackMessage}
            placeholder="I’m sorry, I don’t have enough information to answer that."
            onChange={(e) => update('humanSupport', { fallbackMessage: e.target.value || null })}
          />
        )}

        <Input
          id="handoff-message"
          label="Handoff message"
          value={support.handoffMessage ?? ''}
          disabled={disabled}
          maxLength={LIMITS.handoffMessage}
          placeholder="A teammate will pick this up shortly."
          onChange={(e) => update('humanSupport', { handoffMessage: e.target.value || null })}
        />

        <RadioGroup
          name="human-request-behavior"
          label="When a customer asks for a human"
          orientation="vertical"
          value={support.humanRequestBehavior}
          disabled={disabled}
          onChange={(humanRequestBehavior) => update('humanSupport', { humanRequestBehavior })}
          options={HUMAN_REQUEST_OPTIONS}
        />
      </div>

      <div className="space-y-6">
        <BusinessHoursEditor
          value={support.businessHours}
          disabled={disabled}
          onChange={(businessHours) => update('humanSupport', { businessHours })}
        />
        <ContactFieldsEditor
          value={support.contactCollection}
          disabled={disabled}
          onChange={(contactCollection) => update('humanSupport', { contactCollection })}
        />
      </div>
    </div>
  );
}