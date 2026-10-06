'use client';

import { AuthGuard } from '@/components/auth-guard';
import { PlatformGuard } from '@/components/platform-guard';
import { AppShell } from '@/components/app-shell';
import type { ReactNode } from 'react';

/**
 * Layout for the platform administration area.
 *
 * Two gates, outermost first: `AuthGuard` resolves the session, then `PlatformGuard`
 * requires a PLATFORM_OWNER. They are kept separate so the platform gate never has to
 * reason about a half-loaded session.
 */
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <PlatformGuard>
        <AppShell>{children}</AppShell>
      </PlatformGuard>
    </AuthGuard>
  );
}
