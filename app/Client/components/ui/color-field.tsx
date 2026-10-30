'use client';

import { Input } from '@/components/ui/input';
import { colorInputValue } from '@/lib/experience/config';

interface ColorFieldProps {
  /** Id of the text input; the label points at it. */
  id: string;
  label: string;
  /** `null` means "inherit" for a nullable colour. */
  value: string | null;
  /** A valid six-digit colour shown in the swatch while the value is inherited. */
  fallback: string;
  description?: string;
  error?: string;
  disabled?: boolean;
  /** Offers a "Use default" action, which writes `null`. */
  clearable?: boolean;
  onChange: (value: string | null) => void;
}

/**
 * A colour setting with two real controls: the platform picker and a text field.
 *
 * The text field is not a fallback for browsers that lack a picker — it is the accessible
 * path. A native colour input announces little more than its value, so the hex field
 * beside it is the one a keyboard or screen-reader user can type into, and it is the one
 * the visible label points at.
 *
 * Both controls write the same draft field. The text field is allowed to hold a partial
 * value mid-typing; validation reports it inline and the studio blocks the save, rather
 * than the input swallowing keystrokes.
 */
export function ColorField({
  id,
  label,
  value,
  fallback,
  description,
  error,
  disabled = false,
  clearable = false,
  onChange,
}: ColorFieldProps) {
  const hintId = description ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {clearable && value !== null && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(null)}
            className="cursor-pointer text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            Use default
          </button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} colour picker`}
          value={colorInputValue(value, fallback)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-11 shrink-0 cursor-pointer rounded-lg border border-border bg-background p-1 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Input
          id={id}
          value={value ?? ''}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          placeholder={fallback}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value || null)}
        />
      </div>

      {description && (
        <p id={hintId} className="text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
