import type { ReactNode } from 'react';

interface ExperienceSectionProps {
  id: string;
  title: string;
  description?: string;
  /** A short, real detail for the heading row — a count, a status, a scope. */
  aside?: ReactNode;
  children: ReactNode;
}

/**
 * One band of the Design tab: a sentence-case heading, one line about what the setting
 * changes, and its controls. No border — the gap between bands is the separator, so the
 * page does not become a stack of nested cards.
 */
export function ExperienceSection({
  id,
  title,
  description,
  aside,
  children,
}: ExperienceSectionProps) {
  return (
    <section aria-labelledby={id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={id} className="text-sm font-semibold text-foreground">
          {title}
        </h2>
        {aside}
      </div>
      {description && (
        <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}
