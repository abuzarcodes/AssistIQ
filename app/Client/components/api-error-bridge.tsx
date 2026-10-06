'use client';

import { useEffect } from 'react';
import { onForbidden } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';

/**
 * Bridges module-level API failures into the toast UI.
 *
 * `api-client.ts` is plain TypeScript with no React dependency, so it cannot render
 * anything itself. It publishes 403s on a subscription instead, and this component —
 * mounted once, inside `ToastProvider` — turns each one into a toast.
 *
 * The result: a permission denial explains itself in place. The user stays signed in on
 * the page they were on, which matters because a 403 says "your session is fine, this
 * particular action is not yours to take" — the opposite of the 401 that ends a session.
 */
export function ApiErrorBridge() {
  const { toast } = useToast();

  useEffect(() => {
    return onForbidden((error) => {
      toast(error.message || 'You do not have permission to do that.', 'error');
    });
  }, [toast]);

  return null;
}
