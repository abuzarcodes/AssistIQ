'use client';

import { AlertTriangle } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import type { Bot } from '@/lib/api/bots';
import type { SelectableModel } from '@/lib/api/models';
import type { EffectiveInfo } from '@/lib/api/botConfig';
import { LIMITS } from './config-options';
import type { TabProps } from './tab-props';

interface AiModelTabProps extends TabProps {
  bot: Bot;
  models: SelectableModel[];
  modelsLoading: boolean;
  modelsError: boolean;
  effective: EffectiveInfo;
  savingModel: boolean;
  onAssignModel: (data: { aiModelId?: string | null; fallbackAiModelId?: string | null }) => void;
}

const PLATFORM_DEFAULT = '';

/**
 * AI model and generation parameters (plan §12, §16.1).
 *
 * Model assignment saves **immediately** through `PATCH /bots/:id/model`, preserving the
 * careful unavailable-model warning the page already had. The sampling parameters are part
 * of the draft, and a parameter the serving model cannot use is disabled and reported via
 * `effective.ignoredParams` — the stored value is never cleared, so an owner's settings
 * survive a temporary model swap.
 */
export function AiModelTab({
  bot,
  config,
  update,
  disabled,
  models,
  modelsLoading,
  modelsError,
  effective,
  savingModel,
  onAssignModel,
}: AiModelTabProps) {
  const assignedUnavailable =
    bot.aiModel != null && (!bot.aiModel.enabled || !bot.aiModel.provider.enabled);
  const fallbackUnavailable =
    bot.fallbackAiModel != null &&
    (!bot.fallbackAiModel.enabled || !bot.fallbackAiModel.provider.enabled);

  const ignored = new Set(effective.ignoredParams);

  const modelOptions = [
    { value: PLATFORM_DEFAULT, label: 'Platform default' },
    ...(assignedUnavailable && bot.aiModel
      ? [
          {
            value: bot.aiModel.id,
            label: `${bot.aiModel.provider.name} — ${bot.aiModel.displayName} — unavailable`,
            disabled: true,
          },
        ]
      : []),
    ...models.map((m) => ({ value: m.id, label: `${m.provider.name} — ${m.displayName}` })),
  ];

  const fallbackOptions = [
    { value: PLATFORM_DEFAULT, label: 'No fallback' },
    ...(fallbackUnavailable && bot.fallbackAiModel
      ? [
          {
            value: bot.fallbackAiModel.id,
            label: `${bot.fallbackAiModel.provider.name} — ${bot.fallbackAiModel.displayName} — unavailable`,
            disabled: true,
          },
        ]
      : []),
    ...models.map((m) => ({ value: m.id, label: `${m.provider.name} — ${m.displayName}` })),
  ];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        {modelsLoading ? (
          <div className="flex justify-center py-6">
            <Spinner size="lg" />
          </div>
        ) : modelsError ? (
          <p className="text-sm text-muted-foreground">
            The list of available models could not be loaded. Try reloading the page.
          </p>
        ) : (
          <>
            <Select
              id="primary-model"
              label="Primary model"
              value={bot.aiModelId ?? PLATFORM_DEFAULT}
              disabled={disabled || savingModel}
              options={modelOptions}
              onChange={(e) =>
                onAssignModel({
                  aiModelId: e.target.value === PLATFORM_DEFAULT ? null : e.target.value,
                })
              }
            />
            <Select
              id="fallback-model"
              label="Fallback model"
              value={bot.fallbackAiModelId ?? PLATFORM_DEFAULT}
              disabled={disabled || savingModel}
              options={fallbackOptions}
              onChange={(e) =>
                onAssignModel({
                  fallbackAiModelId: e.target.value === PLATFORM_DEFAULT ? null : e.target.value,
                })
              }
            />

            {effective.modelPromoted && (
              <div className="flex items-start gap-2 rounded-lg bg-[var(--amber-50)] px-3 py-2.5 text-xs text-[var(--amber-600)] dark:bg-[color-mix(in_srgb,var(--amber-500)_15%,transparent)] dark:text-[var(--amber-500)]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Your primary model is unavailable, so the fallback is serving this bot.
                </span>
              </div>
            )}
            {effective.modelUnavailable && (
              <div className="flex items-start gap-2 rounded-lg bg-[var(--red-50)] px-3 py-2.5 text-xs text-[var(--red-600)] dark:bg-[color-mix(in_srgb,var(--red-600)_15%,transparent)] dark:text-[var(--red-500)]">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  No usable model is assigned, so chat escalates to a human without calling a
                  model.
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="space-y-5">
        <Slider
          id="temperature"
          label="Temperature"
          min={0}
          max={2}
          step={0.1}
          value={config.generation.temperature}
          valueText={config.generation.temperature.toFixed(1)}
          hint="Higher values make answers more varied; lower values more deterministic."
          disabled={disabled || ignored.has('temperature')}
          onChange={(temperature) => update('generation', { temperature })}
        />

        <NullableSlider
          id="top-p"
          label="Top P"
          min={0.05}
          max={1}
          step={0.05}
          value={config.generation.topP}
          defaultValue={0.9}
          disabled={disabled || ignored.has('topP')}
          onChange={(topP) => update('generation', { topP })}
        />

        <NullableSlider
          id="frequency-penalty"
          label="Frequency penalty"
          min={-2}
          max={2}
          step={0.1}
          value={config.generation.frequencyPenalty}
          defaultValue={0}
          disabled={disabled || ignored.has('frequencyPenalty')}
          onChange={(frequencyPenalty) => update('generation', { frequencyPenalty })}
        />

        <NullableSlider
          id="presence-penalty"
          label="Presence penalty"
          min={-2}
          max={2}
          step={0.1}
          value={config.generation.presencePenalty}
          defaultValue={0}
          disabled={disabled || ignored.has('presencePenalty')}
          onChange={(presencePenalty) => update('generation', { presencePenalty })}
        />

        <div className="flex items-end gap-3">
          <div className="flex-1">
            <Input
              id="max-output-tokens"
              label="Max output tokens"
              type="number"
              min={LIMITS.maxOutputTokensMin}
              max={LIMITS.maxOutputTokensMax}
              value={config.generation.maxOutputTokens ?? ''}
              disabled={disabled || ignored.has('maxTokens')}
              placeholder="Model default"
              onChange={(e) =>
                update('generation', {
                  maxOutputTokens: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </div>
        </div>

        {effective.ignoredParams.length > 0 && (
          <p className="text-xs text-muted-foreground">
            The selected model does not use:{' '}
            {effective.ignoredParams
              .map((p) => (p === 'topP' ? 'Top P' : p === 'maxTokens' ? 'Max tokens' : p === 'frequencyPenalty' ? 'Frequency penalty' : p === 'presencePenalty' ? 'Presence penalty' : 'Temperature'))
              .join(', ')}
            . Your settings are kept and reactivate on a capable model.
          </p>
        )}
      </div>
    </div>
  );
}

interface NullableSliderProps {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number | null;
  defaultValue: number;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}

/** A slider whose underlying value can be `null` ("do not send this parameter"). */
function NullableSlider({
  id,
  label,
  min,
  max,
  step,
  value,
  defaultValue,
  disabled,
  onChange,
}: NullableSliderProps) {
  const enabled = value !== null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <Switch
          label={`Use ${label}`}
          checked={enabled}
          disabled={disabled}
          onChange={(checked) => onChange(checked ? defaultValue : null)}
        />
      </div>
      {enabled && (
        <Slider
          id={id}
          label={label}
          min={min}
          max={max}
          step={step}
          value={value ?? defaultValue}
          valueText={value?.toFixed(2)}
          disabled={disabled}
          onChange={onChange}
        />
      )}
    </div>
  );
}