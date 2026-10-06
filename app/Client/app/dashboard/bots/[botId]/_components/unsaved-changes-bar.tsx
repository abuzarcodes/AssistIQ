'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface UnsavedChangesBarProps {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  onDiscard: () => void;
  onSave: () => void;
}

/**
 * The sticky save bar (plan §16.2).
 *
 * Appears only when the draft differs from the last server-confirmed configuration. A failed
 * save shows the error here **and** leaves the draft untouched: losing an owner's typed
 * instructions because a request failed is the worst outcome this feature can produce.
 *
 * `role="status"` with `aria-live="polite"` announces its appearance without interrupting.
 */
export function UnsavedChangesBar({
  dirty,
  saving,
  error,
  onDiscard,
  onSave,
}: UnsavedChangesBarProps) {
  if (!dirty) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky bottom-4 z-20 mt-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-lg">
        <div className="flex items-center gap-2 text-sm text-foreground">
          {error ? (
            <>
              <AlertCircle className="h-4 w-4 text-destructive" />
              <span className="text-destructive">{error}</span>
            </>
          ) : (
            <span>You have unsaved changes.</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          <Button size="sm" loading={saving} onClick={onSave}>
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}