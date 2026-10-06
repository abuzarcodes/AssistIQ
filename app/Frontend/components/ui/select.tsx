import { type SelectHTMLAttributes, forwardRef } from 'react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: SelectOption[];
}

/**
 * A native `<select>`, styled to match `Input` — same label, `id` and `error` props, same
 * border, height and focus treatment.
 *
 * Native rather than a custom listbox on purpose: it is keyboard- and screen-reader-correct
 * for free, it renders as the platform's own picker on touch devices, and nothing in this
 * UI needs the styling control a custom control would buy. The kit had no select at all;
 * this is an addition in the existing idiom, not a new pattern.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, id, className = '', ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={id} className="text-sm font-medium text-foreground">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={id}
          className={`h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground transition-colors focus:border-accent focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
            error ? 'border-destructive' : ''
          } ${className}`}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  },
);

Select.displayName = 'Select';
