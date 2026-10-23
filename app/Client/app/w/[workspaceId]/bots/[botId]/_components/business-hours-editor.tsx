'use client';

import { useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { RadioGroup } from '@/components/ui/radio-group';
import type { BusinessHours, BusinessHoursWindow } from '@/lib/api/botConfig';
import { AFTER_HOURS_OPTIONS, DAY_OPTIONS, listTimezones } from './config-options';

interface BusinessHoursEditorProps {
  value: BusinessHours | null;
  onChange: (value: BusinessHours | null) => void;
  disabled?: boolean;
}

const DEFAULT_HOURS: BusinessHours = {
  timezone: 'UTC',
  windows: [{ day: 'MON', start: '09:00', end: '17:00' }],
  afterHoursBehavior: 'MESSAGE_AND_ESCALATE',
  afterHoursMessage: null,
};

/**
 * Business hours and after-hours behaviour (plan §14.3).
 *
 * `null` means "no hours restriction" — escalation is always considered in-hours, which is
 * the default and the pre-feature behaviour. Enabling creates a valid starter schedule so
 * the owner never has to assemble one from nothing.
 *
 * Validation mirrors the server: at most one window per day, and a window must start before
 * it ends. The server is still the authority; this is for immediate feedback.
 */
export function BusinessHoursEditor({ value, onChange, disabled }: BusinessHoursEditorProps) {
  const timezones = useMemo(() => listTimezones(), []);
  const enabled = value !== null;

  function update(patch: Partial<BusinessHours>) {
    if (!value) return;
    onChange({ ...value, ...patch });
  }

  function updateWindow(index: number, patch: Partial<BusinessHoursWindow>) {
    if (!value) return;
    const windows = value.windows.map((w, i) => (i === index ? { ...w, ...patch } : w));
    update({ windows });
  }

  function addWindow() {
    if (!value || value.windows.length >= 7) return;
    const used = new Set(value.windows.map((w) => w.day));
    const day = DAY_OPTIONS.find((d) => !used.has(d.value))?.value ?? 'MON';
    update({ windows: [...value.windows, { day, start: '09:00', end: '17:00' }] });
  }

  function removeWindow(index: number) {
    if (!value) return;
    update({ windows: value.windows.filter((_, i) => i !== index) });
  }

  const duplicateDays =
    value !== null && new Set(value.windows.map((w) => w.day)).size !== value.windows.length;
  const invalidWindows =
    value !== null && value.windows.some((w) => w.start >= w.end);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-medium text-foreground">Business hours</span>
          <p className="text-xs text-muted-foreground">
            When off, escalations are always treated as in-hours.
          </p>
        </div>
        <Switch
          label="Enable business hours"
          checked={enabled}
          disabled={disabled}
          onChange={(checked) => onChange(checked ? DEFAULT_HOURS : null)}
        />
      </div>

      {value && (
        <div className="flex flex-col gap-4 rounded-lg border border-border p-3">
          <Select
            id="business-hours-timezone"
            label="Timezone"
            value={value.timezone}
            disabled={disabled}
            onChange={(e) => update({ timezone: e.target.value })}
            options={timezones.map((tz) => ({ value: tz, label: tz }))}
          />

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Open windows</span>
            {value.windows.map((window, index) => (
              <div key={index} className="flex flex-wrap items-end gap-2">
                <div className="w-36">
                  <Select
                    id={`window-day-${index}`}
                    aria-label={`Day for window ${index + 1}`}
                    value={window.day}
                    disabled={disabled}
                    onChange={(e) =>
                      updateWindow(index, { day: e.target.value as BusinessHoursWindow['day'] })
                    }
                    options={DAY_OPTIONS.map((d) => ({ value: d.value, label: d.label }))}
                  />
                </div>
                <div className="w-32">
                  <Input
                    id={`window-start-${index}`}
                    aria-label={`Start for window ${index + 1}`}
                    type="time"
                    value={window.start}
                    disabled={disabled}
                    onChange={(e) => updateWindow(index, { start: e.target.value })}
                  />
                </div>
                <span className="pb-2 text-xs text-muted-foreground">to</span>
                <div className="w-32">
                  <Input
                    id={`window-end-${index}`}
                    aria-label={`End for window ${index + 1}`}
                    type="time"
                    value={window.end}
                    disabled={disabled}
                    onChange={(e) => updateWindow(index, { end: e.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove window ${index + 1}`}
                  disabled={disabled || value.windows.length <= 1}
                  onClick={() => removeWindow(index)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {(duplicateDays || invalidWindows) && (
              <p className="text-xs text-destructive">
                {duplicateDays
                  ? 'Only one window per day is supported.'
                  : 'A window must start before it ends.'}
              </p>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={disabled || value.windows.length >= 7}
              onClick={addWindow}
            >
              <Plus className="h-3.5 w-3.5" />
              Add window
            </Button>
          </div>

          <RadioGroup
            name="after-hours-behavior"
            label="Outside business hours"
            orientation="vertical"
            value={value.afterHoursBehavior}
            disabled={disabled}
            onChange={(behavior) => update({ afterHoursBehavior: behavior })}
            options={AFTER_HOURS_OPTIONS}
          />

          <Input
            id="after-hours-message"
            label="After-hours message"
            value={value.afterHoursMessage ?? ''}
            disabled={disabled}
            maxLength={500}
            placeholder="Our team is offline. We'll reply first thing tomorrow."
            onChange={(e) => update({ afterHoursMessage: e.target.value || null })}
          />
        </div>
      )}
    </div>
  );
}