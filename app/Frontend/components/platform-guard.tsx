'use client';

import { useAuth } from '@/lib/auth-context';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { Spinner } from '@/components/ui/spinner';

/**
 * Gate for the /platform area: requires an authenticated PLATFORM_OWNER.
 *
 * This is a *navigation* guard, not a security control. Every `/platform/*` endpoint is
 * already behind `requirePlatformOwner()` on the server, so a non-owner who defeats this
 * component gets a 403 and nothing else. What it buys is a coherent UI: a normal user who
 * types the URL is sent back to their dashboard instead of landing on a page that will
 * only ever show errors.
 *
 * Nest it *inside* `AuthGuard` — this component assumes the user has already resolved and
 * deliberately does nothing until `loading` is false, so it never redirects during the
 * initial session check.
 */
export function PlatformGuard({ children }: { children: ReactNode }) {
  const { loading, isPlatformOwner } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !isPlatformOwner) {
      router.replace('/dashboard');
    }
  }, [loading, isPlatformOwner, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!isPlatformOwner) return null;

  return <>{children}</>;
}
