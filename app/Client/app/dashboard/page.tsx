'use client';

import { useAuth } from '@/lib/auth-context';
import { useEffect, useState } from 'react';
import { Card, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { FolderOpen, Plus, FlaskConical, Bot } from 'lucide-react';
import { listWorkspaces, type Workspace } from '@/lib/api/workspaces';
import Link from 'next/link';

export default function DashboardPage() {
  const { user, isPlatformOwner } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listWorkspaces()
      .then(setWorkspaces)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-foreground">
          Welcome back, {user?.name}
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Here&apos;s an overview of your AssistIQ workspace.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <Card>
          <CardBody>
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-[var(--accent-50)] dark:bg-[color-mix(in_srgb,var(--accent-600)_15%,transparent)] p-2">
                <FolderOpen className="h-4 w-4 text-accent" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Workspaces</p>
                {loading ? (
                  <Spinner size="sm" />
                ) : (
                  <p className="text-lg font-semibold text-foreground">
                    {workspaces.length}
                  </p>
                )}
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-[var(--green-50)] dark:bg-[color-mix(in_srgb,var(--green-600)_15%,transparent)] p-2">
                <Bot className="h-4 w-4 text-[var(--green-600)] dark:text-[var(--green-500)]" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Account</p>
                <p className="text-sm font-medium text-foreground truncate">
                  {user?.email}
                </p>
              </div>
            </div>
          </CardBody>
        </Card>

        {isPlatformOwner && (
          <Card>
            <CardBody>
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-[var(--amber-50)] dark:bg-[color-mix(in_srgb,var(--amber-500)_15%,transparent)] p-2">
                  <FlaskConical className="h-4 w-4 text-[var(--amber-500)]" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">AI Lab</p>
                  <p className="text-sm font-medium text-foreground">
                    Platform owner
                  </p>
                </div>
              </div>
            </CardBody>
          </Card>
        )}
      </div>

      {/* Quick Actions */}
      <h2 className="text-sm font-semibold text-foreground mb-3">
        Quick Actions
      </h2>
      <div className="flex flex-wrap gap-3">
        <Link href="/dashboard/workspaces">
          <Button variant="secondary" size="sm">
            <FolderOpen className="h-3.5 w-3.5" />
            View Workspaces
          </Button>
        </Link>
        <Link href="/dashboard/workspaces?create=true">
          <Button size="sm">
            <Plus className="h-3.5 w-3.5" />
            Create Workspace
          </Button>
        </Link>
        {isPlatformOwner && (
          <Link href="/platform/ai-lab">
            <Button variant="secondary" size="sm">
              <FlaskConical className="h-3.5 w-3.5" />
              Open AI Lab
            </Button>
          </Link>
        )}
      </div>
    </div>
  );
}
