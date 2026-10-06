'use client';

import { AlertTriangle } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { RadioGroup } from '@/components/ui/radio-group';
import { Slider } from '@/components/ui/slider';
import { LIMITS, STRICTNESS_OPTIONS } from './config-options';
import type { TabProps } from './tab-props';

/**
 * Knowledge behaviour (plan §15). `strictness` is a three-way preset, not a numeric
 * threshold — exposing the raw score would be the deferred retrieval debugger.
 */
export function KnowledgeTab({ config, update, disabled }: TabProps) {
  const enabled = config.knowledge.enabled;

  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
        <div>
          <span className="text-sm font-medium text-foreground">Use the knowledge base</span>
          <p className="text-xs text-muted-foreground">
            Retrieve uploaded documents and FAQ entries to ground answers.
          </p>
        </div>
        <Switch
          label="Use knowledge base"
          checked={enabled}
          disabled={disabled}
          onChange={(knowledgeEnabled) => update('knowledge', { enabled: knowledgeEnabled })}
        />
      </div>

      {!enabled && (
        <div className="flex items-start gap-2 rounded-lg bg-[var(--amber-50)] px-3 py-2.5 text-xs text-[var(--amber-600)] dark:bg-[color-mix(in_srgb,var(--amber-500)_15%,transparent)] dark:text-[var(--amber-500)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This bot will answer from the model’s general knowledge. It may state things that
            are not true about your business.
          </span>
        </div>
      )}

      {enabled && (
        <>
          <RadioGroup
            name="strictness"
            label="Knowledge strictness"
            orientation="vertical"
            value={config.knowledge.strictness}
            disabled={disabled}
            onChange={(strictness) => update('knowledge', { strictness })}
            options={STRICTNESS_OPTIONS}
          />

          <Slider
            id="retrieval-top-k"
            label="Passages to look at"
            min={LIMITS.topKMin}
            max={LIMITS.topKMax}
            step={1}
            value={config.knowledge.topK}
            valueText={`${config.knowledge.topK} passage${config.knowledge.topK === 1 ? '' : 's'}`}
            disabled={disabled}
            onChange={(topK) => update('knowledge', { topK })}
          />

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <div>
              <span className="text-sm font-medium text-foreground">Show knowledge sources</span>
              <p className="text-xs text-muted-foreground">
                List the documents an answer drew on, below the reply.
              </p>
            </div>
            <Switch
              label="Show knowledge sources"
              checked={config.knowledge.showSources}
              disabled={disabled}
              onChange={(showSources) => update('knowledge', { showSources })}
            />
          </div>
        </>
      )}
    </div>
  );
}