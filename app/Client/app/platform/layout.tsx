'use client';

import { AuthGuard } from '@/components/auth-guard';
import { PlatformGuard } from '@/components/platform-guard';
import { PlatformShell } from '@/components/platform-shell';
import type { ReactNode } from 'react';

/**
 * Layout for the platform administration area.
 *
 * Two gates, outermost first: `AuthGuard` resolves the session, then `PlatformGuard`
 * requires a PLATFORM_OWNER. They are kept separate so the platform gate never has to
 * reason about a half-loaded session. The shell is the same navigation language as the
 * workspace area, so following a platform link does not drop the owner into the legacy
 * dashboard chrome.
 */
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <PlatformGuard>
        <PlatformShell>{children}</PlatformShell>
      </PlatformGuard>
    </AuthGuard>
  );
}
