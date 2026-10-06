'use client';

import type { ReactNode } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** The consequence, in one or two sentences. Rendered as ordinary body text. */
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
  /**
   * `danger` for anything that destroys data. The default is `primary`, which is right for
   * confirming a non-destructive action — a red button that only says "Continue" teaches
   * people to ignore red buttons.
   */
  variant?: 'danger' | 'primary';
}

/**
 * A confirmation for an action that cannot be undone.
 *
 * Wraps `Dialog` rather than rebuilding it, so focus handling, Escape and backdrop
 * dismissal stay in one place. The confirmation is intentionally not dismissible by
 * accident: the confirm button is the only thing that proceeds, and closing without it is
 * always the safe outcome.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
  loading = false,
  variant = 'danger',
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <div className="text-sm text-muted-foreground space-y-2">{description}</div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant={variant} size="sm" loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
