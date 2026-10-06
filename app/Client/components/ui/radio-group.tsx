'use client';

import { useRef, type KeyboardEvent } from 'react';

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface RadioGroupProps<T extends string> {
  name: string;
  label?: string;
  value: T;
  options: RadioOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** A segmented control (default) or a stacked list for longer option sets. */
  orientation?: 'horizontal' | 'vertical';
  error?: string;
}

/**
 * A radio group with roving-tabindex arrow-key navigation.
 *
 * Built on buttons rather than native inputs so the segmented styling is possible, but with
 * the ARIA the native control would have given us for free: `role="radiogroup"`, `role="radio"`
 * and `aria-checked` on each option, and Left/Right (or Up/Down) moving the selection. Only
 * the selected option is in the tab order, which is the correct keyboard model for a group.
 */
export function RadioGroup<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
  disabled = false,
  orientation = 'horizontal',
  error,
}: RadioGroupProps<T>) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const backward = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!forward && !backward) return;
    e.preventDefault();

    const enabled = options.filter((o) => !o.disabled);
    if (enabled.length === 0) return;
    const current = options[index];
    const enabledIndex = enabled.findIndex((o) => o.value === current.value);
    const nextEnabledIndex =
      (enabledIndex + (forward ? 1 : -1) + enabled.length) % enabled.length;
    const next = enabled[nextEnabledIndex];
    onChange(next.value);
    refs.current[next.value]?.focus();
  }

  return (
    <div className="flex flex-col gap-1.5">
      {label && <span className="text-sm font-medium text-foreground">{label}</span>}
      <div
        role="radiogroup"
        aria-label={label ?? name}
        className={
          orientation === 'horizontal'
            ? 'flex flex-wrap gap-1 rounded-lg bg-muted p-1'
            : 'flex flex-col gap-1'
        }
      >
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              ref={(el) => {
                refs.current[option.value] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              disabled={disabled || option.disabled}
              onClick={() => onChange(option.value)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={`cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option.label}
              {option.hint && (
                <span className="block text-xs text-muted-foreground">{option.hint}</span>
              )}
            </button>
          );
        })}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}