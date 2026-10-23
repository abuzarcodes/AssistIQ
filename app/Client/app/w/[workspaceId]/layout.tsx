'use client';

import type { ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { AuthGuard } from '@/components/auth-guard';
import { WorkspaceShell } from '@/components/workspace-shell';
import { WorkspaceProvider } from '@/lib/workspace-context';

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params.workspaceId;

  return (
    <AuthGuard>
      <WorkspaceProvider key={workspaceId} workspaceId={workspaceId}>
        <WorkspaceShell>{children}</WorkspaceShell>
      </WorkspaceProvider>
    </AuthGuard>
  );
}
