'use client';

interface SliderProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** The spoken value, e.g. "0.7, balanced" — the raw number alone says little. */
  valueText?: string;
  hint?: string;
  disabled?: boolean;
}

/**
 * A native range input, painted with tokens.
 *
 * Native because it is keyboard-, touch- and screen-reader-correct for free — the same
 * reasoning `Switch` documents. `aria-valuetext` carries the human readout, so a screen
 * reader announces "0.7, balanced" rather than an unlabelled decimal.
 */
export function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  valueText,
  hint,
  disabled = false,
}: SliderProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        <span className="text-xs tabular-nums text-muted-foreground">
          {valueText ?? value}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={valueText}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-[var(--accent-500)] disabled:cursor-not-allowed disabled:opacity-50"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}