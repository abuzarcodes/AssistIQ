'use client';

import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { listPlatformWorkspaces, type PlatformWorkspace } from '@/lib/api/platform';

export default function PlatformWorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<PlatformWorkspace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listPlatformWorkspaces()
      .then(setWorkspaces)
      .catch(() => {
        // A failure here is already surfaced by ApiErrorBridge.
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-foreground">Workspaces</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Every tenant on the platform, including ones you are not a member of.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All workspaces</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner size="lg" />
            </div>
          ) : workspaces.length === 0 ? (
            <EmptyState icon={FolderOpen} title="No workspaces yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">Name</th>
                    <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">Owner</th>
                    <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">Members</th>
                    <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">Bots</th>
                  </tr>
                </thead>
                <tbody>
                  {workspaces.map((workspace) => (
                    <tr key={workspace.id} className="border-b border-border last:border-0">
                      <td className="px-5 py-3 text-foreground">{workspace.name}</td>
                      <td className="px-5 py-3 text-muted-foreground">
                        {workspace.owner?.email ?? '—'}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">
                        {workspace._count?.members ?? 0}
                      </td>
                      <td className="px-5 py-3 text-muted-foreground">
                        {workspace._count?.bots ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
