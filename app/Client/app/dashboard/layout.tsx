'use client';

import { AuthGuard } from '@/components/auth-guard';
import { AppShell } from '@/components/app-shell';
import type { ReactNode } from 'react';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <AppShell>{children}</AppShell>
    </AuthGuard>
  );
}
