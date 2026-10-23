'use client';

import type { ReactNode } from 'react';
import { AuthGuard } from '@/components/auth-guard';
import { GlobalShell } from '@/components/global-shell';

export default function HomeLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <GlobalShell>{children}</GlobalShell>
    </AuthGuard>
  );
}
