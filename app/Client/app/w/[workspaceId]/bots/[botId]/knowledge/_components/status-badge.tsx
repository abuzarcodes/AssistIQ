'use client';

import { Badge } from '@/components/ui/badge';
import type { KnowledgeSourceStatus } from '@/lib/api/knowledgeSources';

const STATUS: Record<
  KnowledgeSourceStatus,
  { variant: 'success' | 'warning' | 'danger' | 'info'; label: string; pulse: boolean }
> = {
  PENDING: { variant: 'warning', label: 'Pending', pulse: true },
  PROCESSING: { variant: 'info', label: 'Processing', pulse: true },
  PROCESSED: { variant: 'success', label: 'Processed', pulse: false },
  FAILED: { variant: 'danger', label: 'Failed', pulse: false },
};

/**
 * A source's ingestion status.
 *
 * The two in-flight states get a pulsing dot because they are the only ones that are
 * expected to change on their own — a static "Processing" badge looks identical to one
 * that has been stuck there for an hour, and the dot is what distinguishes "working" from
 * "abandoned".
 *
 * The mapping is exhaustive over the status union, so adding a status server-side is a
 * compile error here rather than a badge that renders blank at runtime.
 */
export function StatusBadge({ status }: { status: KnowledgeSourceStatus }) {
  const { variant, label, pulse } = STATUS[status];

  return (
    <Badge variant={variant} dot={pulse}>
      {label}
    </Badge>
  );
}
