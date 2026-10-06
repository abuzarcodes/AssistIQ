'use client';

import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { listPlatformUsers, type PlatformUser } from '@/lib/api/platform';

export default function PlatformUsersPage() {
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listPlatformUsers()
      .then(setUsers)
      .catch(() => {
        // A failure here is already surfaced by ApiErrorBridge.
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-foreground">Users</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Every account on the platform. This view crosses tenant boundaries.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All users</CardTitle>
        </CardHeader>
        <CardBody className="p-0">
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner size="lg" />
            </div>
          ) : users.length === 0 ? (
            <EmptyState icon={Users} title="No users yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">Name</th>
                    <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">Email</th>
                    <th className="px-5 py-2.5 text-xs font-medium text-muted-foreground">Platform role</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className="border-b border-border last:border-0">
                      <td className="px-5 py-3 text-foreground">{user.name}</td>
                      <td className="px-5 py-3 text-muted-foreground">{user.email}</td>
                      <td className="px-5 py-3">
                        <Badge variant={user.platformRole === 'PLATFORM_OWNER' ? 'info' : 'default'}>
                          {user.platformRole}
                        </Badge>
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
