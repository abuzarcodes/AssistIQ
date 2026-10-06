import type { ReactNode } from 'react';

interface FieldProps {
  /** The id of the control this field labels, for `htmlFor`. */
  htmlFor: string;
  label: string;
  hint?: string;
  error?: string;
  /** A character counter, e.g. `{ current: 12, max: 500 }`. */
  counter?: { current: number; max: number };
  children: ReactNode;
}

/**
 * A labelled form field with hint text, an error, and an optional character counter.
 *
 * `Input`, `Textarea` and `Select` already own their label and error; this wrapper adds the
 * two things prompt-length fields need — a hint and a counter — without a second copy of
 * the label markup. The counter is wired to the control through `aria-describedby` rather
 * than a live region: a counter that announced every keystroke would be hostile.
 */
export function Field({ htmlFor, label, hint, error, counter, children }: FieldProps) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const counterId = counter ? `${htmlFor}-counter` : undefined;
  const describedBy = [hintId, counterId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {counter && (
          <span id={counterId} className="text-xs tabular-nums text-muted-foreground">
            {counter.current}/{counter.max}
          </span>
        )}
      </div>
      <div aria-describedby={describedBy}>{children}</div>
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}