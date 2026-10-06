/**
 * Display formatting shared by the knowledge screens.
 *
 * Kept out of the components because all three of them render the same byte sizes and
 * timestamps — the sources list, the source detail page and the upload dialog would
 * otherwise each carry their own copy, and a size that reads "10.0 MB" in one place and
 * "10 MB" in another looks like a disagreement about the value.
 */

/**
 * A byte count in the largest unit that keeps it readable.
 *
 * One decimal place above KB and none below it: "512 B" and "3.4 KB" are both as precise
 * as anyone reads, and a fixed number of decimals would render "1.0 B".
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A timestamp as "just now", "5m ago", "3h ago", "2d ago", or a date once it is older
 * than a week.
 *
 * Server timestamps are ISO strings, so they are parsed rather than used as-is. A
 * *future* timestamp renders as "just now" instead of a negative age: clock skew between
 * the server and the browser is common and "-2m ago" is not a thing to show a user.
 */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  const elapsed = Date.now() - then;
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;

  return new Date(then).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** An absolute timestamp for tooltips and detail views, where the exact moment matters. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
