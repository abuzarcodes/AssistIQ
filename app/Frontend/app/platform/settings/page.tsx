'use client';

import { useEffect, useMemo, useState } from 'react';
import { SlidersHorizontal, Save } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import {
  getPlatformSettings,
  updatePlatformSettings,
  SETTINGS_LIMITS,
  type PlatformSettings,
  type PlatformSettingsPatch,
  type SettingsField,
} from '@/lib/api/platform';

const MB = 1024 * 1024;

/**
 * How each limit is presented. `bytes` fields are converted to MB for both display and
 * input, so the operator never types an eight-digit number; `count` fields are shown as-is.
 */
const FIELDS: {
  key: SettingsField;
  label: string;
  hint?: string;
}[] = [
  { key: 'maxUploadFileSizeBytes', label: 'Maximum file size (MB)' },
  {
    key: 'maxUploadFilesPerRequest',
    label: 'Maximum files per upload',
    hint: 'How many documents one request may carry.',
  },
  { key: 'maxUploadTotalBytes', label: 'Maximum combined size per upload (MB)' },
  {
    key: 'maxChunksPerSource',
    label: 'Maximum chunks per document',
    hint: 'Bounds how much embedding a single document can cost.',
  },
  {
    key: 'maxChunksPerBot',
    label: 'Maximum chunks per bot',
    hint: 'A lifetime quota across all of a bot’s sources. 0 means unlimited.',
  },
  {
    key: 'aiServiceMaxFileSizeBytes',
    label: 'AI service file-size backstop (MB)',
    hint: 'A safety ceiling, not a per-tier limit. Keep it at or above the maximum file size.',
  },
];

type FormValues = Record<SettingsField, string>;

/** Bytes → the number the operator types, in MB. Rounded to 2dp for display only. */
function toDisplay(key: SettingsField, stored: number): string {
  if (SETTINGS_LIMITS[key].unit !== 'bytes') return String(stored);
  return String(Math.round((stored / MB) * 100) / 100);
}

/** The typed number → the value stored, in bytes for `bytes` fields. */
function toStored(key: SettingsField, typed: number): number {
  return SETTINGS_LIMITS[key].unit === 'bytes' ? Math.round(typed * MB) : typed;
}

function toForm(settings: PlatformSettings): FormValues {
  return FIELDS.reduce((acc, { key }) => {
    acc[key] = toDisplay(key, settings[key]);
    return acc;
  }, {} as FormValues);
}

/**
 * Per-field errors, including the cross-field invariants (section 12.11).
 *
 * The invariants are attached to the field the operator should change, so the message
 * appears next to the input that caused it rather than as a page-level banner.
 */
function validate(values: FormValues): Partial<Record<SettingsField, string>> {
  const errors: Partial<Record<SettingsField, string>> = {};
  const stored: Partial<Record<SettingsField, number>> = {};

  FIELDS.forEach(({ key }) => {
    const raw = values[key].trim();
    const typed = Number(raw);
    const { min, max, unit } = SETTINGS_LIMITS[key];

    if (raw === '' || !Number.isFinite(typed)) {
      errors[key] = 'Enter a number.';
      return;
    }
    if (unit === 'count' && !Number.isInteger(typed)) {
      errors[key] = 'Enter a whole number.';
      return;
    }

    const bytes = toStored(key, typed);
    stored[key] = bytes;

    // Bounds are declared in bytes on the server, so the comparison happens there too.
    if (bytes < min) {
      errors[key] = unit === 'bytes' ? `Minimum is ${min / MB} MB.` : `Minimum is ${min}.`;
    } else if (bytes > max) {
      errors[key] = unit === 'bytes' ? `Maximum is ${max / MB} MB.` : `Maximum is ${max}.`;
    }
  });

  // Only check the relations once both sides are individually valid, or a single bad input
  // would produce two messages for one mistake.
  const fileSize = stored.maxUploadFileSizeBytes;
  const total = stored.maxUploadTotalBytes;
  const backstop = stored.aiServiceMaxFileSizeBytes;

  if (fileSize !== undefined && total !== undefined && !errors.maxUploadTotalBytes && total < fileSize) {
    errors.maxUploadTotalBytes =
      'Must be at least the maximum file size, or no allowed file could ever be uploaded.';
  }
  if (
    fileSize !== undefined &&
    backstop !== undefined &&
    !errors.aiServiceMaxFileSizeBytes &&
    backstop < fileSize
  ) {
    errors.aiServiceMaxFileSizeBytes =
      'Must be at least the maximum file size, or the AI service would reject files the server accepted.';
  }

  return errors;
}

export default function PlatformSettingsPage() {
  const { toast } = useToast();

  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [values, setValues] = useState<FormValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  useEffect(() => {
    getPlatformSettings()
      .then((loaded) => {
        setSettings(loaded);
        setValues(toForm(loaded));
      })
      .catch(() => {
        // The failure is already surfaced by ApiErrorBridge; the page shows its own
        // unavailable state below rather than a second message.
      })
      .finally(() => setLoading(false));
  }, []);

  const errors = useMemo(() => (values ? validate(values) : {}), [values]);
  const hasErrors = Object.keys(errors).length > 0;

  /**
   * Only the fields whose *stored* value actually changed.
   *
   * Comparing bytes rather than the typed strings is what makes this safe: a value that is
   * not a whole number of megabytes redisplays rounded, so resubmitting an untouched field
   * could silently quantize it. An untouched field is never sent, and so never drifts.
   */
  const patch = useMemo<PlatformSettingsPatch>(() => {
    if (!settings || !values) return {};

    return FIELDS.reduce((acc, { key }) => {
      const typed = Number(values[key].trim());
      if (!Number.isFinite(typed)) return acc;

      const stored = toStored(key, typed);
      if (stored !== settings[key]) {
        acc[key] = stored;
      }
      return acc;
    }, {} as PlatformSettingsPatch);
  }, [settings, values]);

  const dirty = Object.keys(patch).length > 0;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || hasErrors) return;

    setSaving(true);
    setServerError('');

    try {
      const updated = await updatePlatformSettings(patch);
      setSettings(updated);
      setValues(toForm(updated));
      toast('Platform settings saved', 'success');
    } catch (err) {
      // The server's invariants are the authority, so its message is shown as-is rather
      // than replaced with a client-side guess at what went wrong.
      setServerError(
        err instanceof ApiError ? err.message : 'Failed to save platform settings.',
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!settings || !values) {
    return (
      <div className="animate-fade-in">
        <div className="mb-6">
          <h1 className="text-lg font-semibold text-foreground">Settings</h1>
        </div>
        <Card>
          <CardBody>
            <p className="text-sm text-muted-foreground">
              Platform settings are unavailable.
            </p>
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Upload limits enforced across every workspace. Changes take effect on the next
          upload, with no restart.
        </p>
      </div>

      <form onSubmit={handleSave}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              Upload limits
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            {serverError && (
              <div className="rounded-lg bg-[var(--red-50)] dark:bg-[color-mix(in_srgb,var(--red-600)_10%,transparent)] border border-[var(--red-500)]/20 px-3 py-2 text-sm text-[var(--red-600)] dark:text-[var(--red-500)]">
                {serverError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {FIELDS.map(({ key, label, hint }) => (
                <div key={key}>
                  <Input
                    id={key}
                    type="number"
                    inputMode="numeric"
                    step={SETTINGS_LIMITS[key].unit === 'bytes' ? '0.1' : '1'}
                    label={label}
                    value={values[key]}
                    error={errors[key]}
                    onChange={(e) =>
                      setValues((prev) =>
                        prev ? { ...prev, [key]: e.target.value } : prev,
                      )
                    }
                  />
                  {hint && !errors[key] && (
                    <p className="text-xs text-muted-foreground mt-1.5">{hint}</p>
                  )}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-muted-foreground">
                {dirty
                  ? `${Object.keys(patch).length} setting${Object.keys(patch).length === 1 ? '' : 's'} changed`
                  : 'No changes yet'}
              </p>
              <Button
                type="submit"
                size="sm"
                loading={saving}
                disabled={!dirty || hasErrors}
              >
                <Save className="h-3.5 w-3.5" />
                Save Changes
              </Button>
            </div>
          </CardBody>
        </Card>
      </form>
    </div>
  );
}
