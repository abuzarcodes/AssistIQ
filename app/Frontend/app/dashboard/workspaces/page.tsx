'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Plus, FolderOpen, ArrowRight } from 'lucide-react';
import {
  listWorkspaces,
  createWorkspace,
  type Workspace,
} from '@/lib/api/workspaces';
import { Card, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';

export default function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    loadWorkspaces();
  }, []);

  useEffect(() => {
    if (searchParams.get('create') === 'true') {
      setDialogOpen(true);
      router.replace('/dashboard/workspaces');
    }
  }, [searchParams, router]);

  async function loadWorkspaces() {
    try {
      const data = await listWorkspaces();
      setWorkspaces(data);
    } catch {
      toast('Failed to load workspaces', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setCreating(true);

    try {
      await createWorkspace(name);
      toast('Workspace created', 'success');
      setDialogOpen(false);
      setName('');
      await loadWorkspaces();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create workspace');
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Workspaces</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage your workspaces and their bots.
          </p>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          New Workspace
        </Button>
      </div>

      {workspaces.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No workspaces yet"
          description="Create your first workspace to get started with AI-powered customer support."
          action={
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Create Workspace
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {workspaces.map((ws) => (
            <Link key={ws.id} href={`/dashboard/workspaces/${ws.id}`}>
              <Card className="hover:border-accent/50 transition-colors cursor-pointer group">
                <CardBody>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg bg-muted p-2 group-hover:bg-[var(--accent-50)] dark:group-hover:bg-[color-mix(in_srgb,var(--accent-600)_15%,transparent)] transition-colors">
                        <FolderOpen className="h-4 w-4 text-muted-foreground group-hover:text-accent transition-colors" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {ws.name}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Created{' '}
                          {new Date(ws.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setError('');
          setName('');
        }}
        title="Create Workspace"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          {error && (
            <div className="rounded-lg bg-[var(--red-50)] dark:bg-[color-mix(in_srgb,var(--red-600)_10%,transparent)] border border-[var(--red-500)]/20 px-3 py-2 text-sm text-[var(--red-600)] dark:text-[var(--red-500)]">
              {error}
            </div>
          )}
          <Input
            id="ws-name"
            label="Workspace name"
            placeholder="e.g. My Support Team"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={creating}>
              Create
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
