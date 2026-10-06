'use client';

import { Loader2 } from 'lucide-react';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name. Required: the track alone says nothing about what it controls. */
  label: string;
  disabled?: boolean;
  /** Shows a spinner in place of the knob while the change is being saved. */
  loading?: boolean;
  className?: string;
}

/**
 * An on/off switch for a single value, used for a chunk's enabled state.
 *
 * Also a native checkbox underneath, for the same reason as `Checkbox`: the control keeps
 * its real semantics and keyboard behaviour, and only the painting is ours.
 *
 * The knob shows a spinner while `loading` rather than moving straight to the new
 * position. A toggle that jumps and then snaps back on failure reads as a glitch; one that
 * waits shows the same thing the server was told.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  loading = false,
  className = '',
}: SwitchProps) {
  return (
    <span className={`relative inline-flex h-5 w-9 shrink-0 ${className}`}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        checked={checked}
        disabled={disabled || loading}
        onChange={(e) => onChange(e.target.checked)}
        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden
        className={`pointer-events-none flex h-5 w-9 items-center rounded-full p-0.5 transition-colors ${
          checked ? 'bg-accent' : 'bg-[var(--gray-300)] dark:bg-[var(--gray-600)]'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <span
          className={`flex h-4 w-4 items-center justify-center rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        >
          {loading && <Loader2 className="h-2.5 w-2.5 animate-spin text-muted-foreground" />}
        </span>
      </span>
    </span>
  );
}
