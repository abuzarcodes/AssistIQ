import type { ReactNode } from 'react';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-muted text-muted-foreground',
  success: 'bg-[var(--green-50)] text-[var(--green-600)] dark:bg-[color-mix(in_srgb,var(--green-600)_15%,transparent)] dark:text-[var(--green-500)]',
  warning: 'bg-[var(--amber-50)] text-[var(--amber-500)] dark:bg-[color-mix(in_srgb,var(--amber-500)_15%,transparent)]',
  danger: 'bg-[var(--red-50)] text-[var(--red-600)] dark:bg-[color-mix(in_srgb,var(--red-600)_15%,transparent)] dark:text-[var(--red-500)]',
  info: 'bg-[var(--blue-50)] text-[var(--blue-500)] dark:bg-[color-mix(in_srgb,var(--blue-500)_15%,transparent)]',
};

const dotColors: Record<BadgeVariant, string> = {
  default: 'bg-muted-foreground',
  success: 'bg-[var(--green-500)]',
  warning: 'bg-[var(--amber-500)]',
  danger: 'bg-[var(--red-500)]',
  info: 'bg-[var(--blue-500)]',
};

export function Badge({ variant = 'default', children, className = '', dot }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${variantClasses[variant]} ${className}`}
    >
      {dot && (
        <span className={`h-1.5 w-1.5 rounded-full ${dotColors[variant]} animate-pulse-dot`} />
      )}
      {children}
    </span>
  );
}
