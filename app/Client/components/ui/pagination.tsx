'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  /** Singular noun for the count line, e.g. "chunk" → "24 chunks". */
  itemLabel: string;
  onPageChange: (page: number) => void;
  /** Disabled while a page is in flight, so a double click cannot skip a page. */
  disabled?: boolean;
}

/**
 * Server-side pagination control.
 *
 * Renders the count and the two arrows, and nothing else: a page-number list would need to
 * know how many pages fit, and every existing list in this app is a short page sequence
 * where the arrows plus "Page 2 of 7" is enough. The server is the only thing that decides
 * what a page contains, so this component never slices — it reports the page it wants.
 *
 * Hidden entirely when there is only one page: a control that cannot do anything is noise.
 */
export function Pagination({
  page,
  totalPages,
  total,
  itemLabel,
  onPageChange,
  disabled = false,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  const atStart = page <= 1;
  const atEnd = page >= totalPages;

  return (
    <div className="flex items-center justify-between gap-4 pt-3">
      <p className="text-xs text-muted-foreground">
        {total} {total === 1 ? itemLabel : `${itemLabel}s`}
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Previous page"
          onClick={() => onPageChange(page - 1)}
          disabled={disabled || atStart}
          className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-xs text-muted-foreground tabular-nums">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          aria-label="Next page"
          onClick={() => onPageChange(page + 1)}
          disabled={disabled || atEnd}
          className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
