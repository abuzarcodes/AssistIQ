'use client';

import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import type { ContactCollection, ContactField } from '@/lib/api/botConfig';
import { CONTACT_FIELD_OPTIONS } from './config-options';

interface ContactFieldsEditorProps {
  value: ContactCollection | null;
  onChange: (value: ContactCollection | null) => void;
  disabled?: boolean;
}

const DEFAULT_COLLECTION: ContactCollection = {
  enabled: true,
  fields: ['name', 'email'],
  required: ['email'],
};

/**
 * Contact information collection (plan §14.6).
 *
 * `null` means disabled. Enabling starts with a sensible pair so the owner is not confronted
 * with an empty form. A required field is always also a collected one — unchecking a field
 * removes it from `required` in the same change, which is the invariant the server enforces.
 */
export function ContactFieldsEditor({ value, onChange, disabled }: ContactFieldsEditorProps) {
  const enabled = value !== null;

  function toggleField(field: ContactField, checked: boolean) {
    if (!value) return;
    const fields = checked
      ? [...value.fields, field]
      : value.fields.filter((f) => f !== field);
    const required = value.required.filter((f) => fields.includes(f));
    onChange({ ...value, fields, required });
  }

  function toggleRequired(field: ContactField, checked: boolean) {
    if (!value) return;
    const required = checked
      ? [...value.required, field]
      : value.required.filter((f) => f !== field);
    onChange({ ...value, required });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-medium text-foreground">Collect contact details</span>
          <p className="text-xs text-muted-foreground">
            Shown as a form after the conversation is handed to a human.
          </p>
        </div>
        <Switch
          label="Collect contact details"
          checked={enabled}
          disabled={disabled}
          onChange={(checked) => onChange(checked ? DEFAULT_COLLECTION : null)}
        />
      </div>

      {value && (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Fields to collect</span>
            <div className="flex flex-wrap gap-4">
              {CONTACT_FIELD_OPTIONS.map((field) => (
                <Checkbox
                  key={field.value}
                  label={field.label}
                  checked={value.fields.includes(field.value)}
                  disabled={disabled}
                  onChange={(checked) => toggleField(field.value, checked)}
                />
              ))}
            </div>
          </div>

          {value.fields.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-foreground">Required fields</span>
              <div className="flex flex-wrap gap-4">
                {CONTACT_FIELD_OPTIONS.filter((f) => value.fields.includes(f.value)).map((field) => (
                  <Checkbox
                    key={field.value}
                    label={field.label}
                    checked={value.required.includes(field.value)}
                    disabled={disabled}
                    onChange={(checked) => toggleRequired(field.value, checked)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}