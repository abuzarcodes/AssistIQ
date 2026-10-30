'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'lucide-react';

export interface CardRadioOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  /** A miniature of what the choice produces. */
  preview?: ReactNode;
  disabled?: boolean;
}

interface CardRadioGroupProps<T extends string> {
  /** The group's accessible name. */
  label: string;
  /** `null` when the draft does not match any option (e.g. customised colours). */
  value: T | null;
  options: CardRadioOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** 3 renders three across on small screens; 2 and 4 render two across. */
  columns?: 2 | 3 | 4;
}

const GRID_CLASSES: Record<2 | 3 | 4, string> = {
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2',
};

/**
 * A radio group whose options are cards, for choices that are easier to recognise than
 * to name: a theme's surface, a preset's palette, a widget's corner.
 *
 * A real radio group underneath: arrow keys move the selection, only the selected card
 * (or the first, when nothing matches) is in the tab order, and the choice is announced
 * as checked. The preview is decorative and hidden from the accessible name; the label
 * and description carry the meaning.
 */
export function CardRadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  columns = 3,
}: CardRadioGroupProps<T>) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) return;

    const enabled = options.filter((option) => !option.disabled);
    if (enabled.length === 0) return;

    event.preventDefault();
    const enabledIndex = enabled.findIndex(
      (option) => option.value === options[index]?.value,
    );
    const next =
      enabled[
        (enabledIndex + (forward ? 1 : -1) + enabled.length) % enabled.length
      ];
    if (!next) return;

    onChange(next.value);
    refs.current[next.value]?.focus();
  }

  const fallbackTabStop = options.find((option) => !option.disabled)?.value;

  return (
    <div role="radiogroup" aria-label={label} className={`grid gap-3 ${GRID_CLASSES[columns]}`}>
      {options.map((option, index) => {
        const selected = option.value === value;
        const tabStop = selected || (value === null && option.value === fallbackTabStop);

        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[option.value] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={tabStop ? 0 : -1}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            className={`group flex cursor-pointer flex-col rounded-xl border bg-card p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 ${
              selected
                ? 'border-accent ring-1 ring-accent/30'
                : 'border-border hover:border-accent/40 hover:bg-muted/20'
            }`}
          >
            {option.preview && (
              <span aria-hidden="true" className="mb-3 block">
                {option.preview}
              </span>
            )}

            <span className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  {option.label}
                </span>
                {option.description && (
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
              {selected && (
                <Check
                  aria-hidden="true"
                  className="mt-0.5 h-4 w-4 shrink-0 text-accent-strong"
                />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
