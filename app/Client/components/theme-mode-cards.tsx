'use client';

import { useRef, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { useTheme, type ThemeMode } from '@/lib/theme-context';
import { THEME_OPTIONS } from '@/components/theme-options';

/**
 * A miniature of the app shell in each theme. It is drawn from the fixed gray ramp
 * (light) and the neutral dark ramp (dark) rather than the live tokens on purpose: the
 * light option must still look light while the page is dark, or the three choices
 * become indistinguishable.
 */
function PreviewPane({
  tone,
  className = '',
}: {
  tone: 'light' | 'dark';
  className?: string;
}) {
  const light = tone === 'light';

  return (
    <span
      aria-hidden="true"
      className={`flex min-h-0 gap-1.5 p-2 ${
        light ? 'bg-[var(--gray-100)]' : 'bg-[var(--neutral-1000)]'
      } ${className}`}
    >
      <span
        className={`flex w-7 shrink-0 flex-col gap-1 rounded-md p-1.5 ${
          light ? 'bg-[var(--gray-200)]' : 'bg-[var(--neutral-900)]'
        }`}
      >
        <span className="h-1 w-4 rounded-full bg-accent" />
        <span
          className={`h-1 w-4 rounded-full ${
            light ? 'bg-[var(--gray-400)]' : 'bg-[var(--neutral-600)]'
          }`}
        />
        <span
          className={`h-1 w-3 rounded-full ${
            light ? 'bg-[var(--gray-300)]' : 'bg-[var(--neutral-700)]'
          }`}
        />
      </span>
      <span
        className={`flex min-w-0 flex-1 flex-col rounded-md p-2 ${
          light ? 'bg-[var(--gray-50)]' : 'bg-[var(--neutral-950)]'
        }`}
      >
        <span
          className={`h-1.5 w-3/4 rounded-full ${
            light ? 'bg-[var(--gray-400)]' : 'bg-[var(--neutral-600)]'
          }`}
        />
        <span
          className={`mt-1.5 h-1 w-full rounded-full ${
            light ? 'bg-[var(--gray-200)]' : 'bg-[var(--neutral-800)]'
          }`}
        />
        <span
          className={`mt-1 h-1 w-2/3 rounded-full ${
            light ? 'bg-[var(--gray-200)]' : 'bg-[var(--neutral-800)]'
          }`}
        />
        <span className="mt-auto h-3 w-10 rounded bg-accent" />
      </span>
    </span>
  );
}

function ThemePreview({ mode }: { mode: ThemeMode }) {
  if (mode === 'system') {
    return (
      <span className="flex h-20 w-full overflow-hidden rounded-lg border border-border">
        <PreviewPane tone="light" className="h-full w-1/2" />
        <PreviewPane tone="dark" className="h-full w-1/2" />
      </span>
    );
  }

  return (
    <span className="block h-20 w-full overflow-hidden rounded-lg border border-border">
      <PreviewPane tone={mode} className="h-full w-full" />
    </span>
  );
}

/**
 * The appearance choice on the profile page.
 *
 * A real radio group rather than three buttons: the arrow keys move between options,
 * only the selected option is in the tab order, and the choice is announced as checked.
 */
export function ThemeModeCards() {
  const { mode, setMode } = useTheme();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';

    if (!forward && !backward) return;
    event.preventDefault();

    const nextIndex =
      (index + (forward ? 1 : -1) + THEME_OPTIONS.length) %
      THEME_OPTIONS.length;
    const next = THEME_OPTIONS[nextIndex];

    setMode(next.value);
    refs.current[next.value]?.focus();
  }

  return (
    <div role="radiogroup" aria-label="Theme" className="grid gap-3 sm:grid-cols-3">
      {THEME_OPTIONS.map((option, index) => {
        const selected = option.value === mode;
        const Icon = option.icon;

        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[option.value] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => setMode(option.value)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={`group flex cursor-pointer flex-col rounded-xl border bg-card p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              selected
                ? 'border-accent ring-1 ring-accent/30'
                : 'border-border hover:border-accent/40 hover:bg-muted/30'
            }`}
          >
            <span className="mb-3 block">
              <ThemePreview mode={option.value} />
            </span>

            <span className="flex items-start gap-2.5">
              <Icon
                aria-hidden="true"
                className={`mt-0.5 h-4 w-4 shrink-0 ${
                  selected ? 'text-accent-strong' : 'text-muted-foreground'
                }`}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  {option.label}
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {option.description}
                </span>
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
