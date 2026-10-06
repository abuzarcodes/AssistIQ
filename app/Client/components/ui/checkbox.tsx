'use client';

import { Check, Minus } from 'lucide-react';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name. Required: a bare box is unlabelled to a screen reader. */
  label: string;
  disabled?: boolean;
  /** Renders a dash instead of a tick — for a header box when only some rows are selected. */
  indeterminate?: boolean;
  className?: string;
}

/**
 * A tri-state-capable checkbox for list selection.
 *
 * A native `<input type="checkbox">` is kept for behaviour (keyboard, form semantics) but
 * visually replaced, because the browser default cannot be themed with the app's tokens.
 * The input stays in the tree and covers the box, so clicking and keyboard focus behave
 * exactly as they would on the native control — the alternative, a `div` with `role`, has
 * to re-implement both.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  indeterminate = false,
  className = '',
}: CheckboxProps) {
  const on = checked || indeterminate;

  return (
    <span className={`relative inline-flex h-4 w-4 shrink-0 ${className}`}>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className={`pointer-events-none flex h-4 w-4 items-center justify-center rounded border transition-colors ${
          on
            ? 'border-accent bg-accent text-accent-foreground'
            : 'border-border bg-background peer-hover:border-accent/50'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        {indeterminate ? (
          <Minus className="h-3 w-3" strokeWidth={3} />
        ) : (
          checked && <Check className="h-3 w-3" strokeWidth={3} />
        )}
      </span>
    </span>
  );
}
