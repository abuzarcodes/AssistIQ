'use client';

import { useEffect, useState } from 'react';
import { Activity, Database, Server } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { getPlatformSystemStatus, type PlatformSystemStatus } from '@/lib/api/platform';

export default function PlatformSystemPage() {
  const [status, setStatus] = useState<PlatformSystemStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getPlatformSystemStatus()
      .then(setStatus)
      .catch(() => {
        // A failure here is already surfaced by ApiErrorBridge.
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-foreground">System</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Platform health. The AI service probe is reported as reachable or not rather than
          failing the whole page.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner size="lg" />
        </div>
      ) : !status ? (
        <Card>
          <CardBody>
            <p className="text-sm text-muted-foreground">System status is unavailable.</p>
          </CardBody>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
            <Card>
              <CardBody>
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-muted p-2">
                    <Database className="h-4 w-4 text-accent" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground">Database</p>
                    <p className="text-sm font-medium text-foreground">
                      {status.service}
                    </p>
                  </div>
                  <Badge variant={status.database.reachable ? 'success' : 'danger'} dot>
                    {status.database.reachable ? 'Reachable' : 'Down'}
                  </Badge>
                </div>
              </CardBody>
            </Card>

            <Card>
              <CardBody>
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-muted p-2">
                    <Server className="h-4 w-4 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-muted-foreground">AI service</p>
                    <p className="text-sm font-medium text-foreground truncate">
                      {status.aiService.reachable
                        ? 'Responding'
                        : status.aiService.error || 'Unreachable'}
                    </p>
                  </div>
                  <Badge variant={status.aiService.reachable ? 'success' : 'danger'} dot>
                    {status.aiService.reachable ? 'Up' : 'Down'}
                  </Badge>
                </div>
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Record counts
              </CardTitle>
            </CardHeader>
            <CardBody>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {(
                  [
                    ['Users', status.counts.users],
                    ['Workspaces', status.counts.workspaces],
                    ['Bots', status.counts.bots],
                    ['Conversations', status.counts.conversations],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="text-lg font-semibold text-foreground">{value}</p>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
