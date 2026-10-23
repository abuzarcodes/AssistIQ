'use client';

import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowUpRight, Plus } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import {
  createWorkspace,
  listWorkspaces,
  type Workspace,
} from '@/lib/api/workspaces';

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function formatCreatedAt(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : dateFormatter.format(date);
}

function workspaceInitial(name: string) {
  return name.trim().charAt(0).toUpperCase() || '?';
}

/**
 * Pick the column count from the number of workspaces so a short list does not
 * leave a single card orphaned beside a mostly empty row.
 */
function workspaceGridColumns(count: number) {
  if (count === 1) return 'max-w-xl';
  if (count === 2) return 'sm:grid-cols-2';
  if (count === 3) return 'md:grid-cols-3';
  if (count === 4) return 'sm:grid-cols-2 lg:grid-cols-4';
  return 'sm:grid-cols-2 lg:grid-cols-3';
}

export default function HomePage() {
  return (
    <Suspense fallback={<HomeLoading />}>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const createRequested = searchParams.get('create') === 'true';
  const isDialogOpen = dialogOpen || createRequested;

  const loadWorkspaces = useCallback(async () => {
    try {
      const data = await listWorkspaces();
      setWorkspaces(data);
      setLoadError('');
    } catch (err) {
      setLoadError(
        err instanceof ApiError
          ? err.message
          : 'We could not load your workspaces.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const data = await listWorkspaces();
        if (!active) return;
        setWorkspaces(data);
        setLoadError('');
      } catch (err) {
        if (!active) return;
        setLoadError(
          err instanceof ApiError
            ? err.message
            : 'We could not load your workspaces.',
        );
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  function closeDialog() {
    setDialogOpen(false);
    setCreateError('');
    if (createRequested) {
      router.replace('/home');
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();

    if (!trimmed) {
      setCreateError('Give the workspace a name.');
      return;
    }

    setCreateError('');
    setCreating(true);

    try {
      const created = await createWorkspace(trimmed);
      setWorkspaces((current) => [created, ...current]);
      closeDialog();
      setName('');
      toast('Workspace created', 'success');
    } catch (err) {
      setCreateError(
        err instanceof ApiError
          ? err.message
          : 'We could not create the workspace.',
      );
    } finally {
      setCreating(false);
    }
  }

  const sorted = [...workspaces].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const description = loading
    ? 'Loading your workspaces…'
    : loadError
      ? undefined
      : sorted.length === 0
        ? 'No workspaces yet'
        : `${sorted.length} workspace${sorted.length === 1 ? '' : 's'}`;

  function retry() {
    setLoading(true);
    void loadWorkspaces();
  }

  return (
    <>
      <PageHeader
        title="Your Workspaces"
        description={description}
        action={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" />
            Create workspace
          </Button>
        }
      />

      {loading ? (
        <WorkspaceGridSkeleton />
      ) : loadError ? (
        <ErrorPanel message={loadError} onRetry={retry} />
      ) : sorted.length === 0 ? (
        <EmptyWorkspaces onCreate={() => setDialogOpen(true)} />
      ) : (
        <div className={`grid grid-cols-1 gap-4 ${workspaceGridColumns(sorted.length)}`}>
          {sorted.map((workspace) => {
            const created = formatCreatedAt(workspace.createdAt);

            return (
              <Link
                key={workspace.id}
                href={`/w/${workspace.id}`}
                className="group flex min-h-[124px] flex-col rounded-xl border border-border bg-card p-4 transition-colors hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[140px] sm:p-5"
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-bg text-sm font-semibold text-accent-bg-foreground"
                  >
                    {workspaceInitial(workspace.name)}
                  </span>
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-semibold text-foreground">
                      {workspace.name}
                    </h2>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      {created ? `Created ${created}` : 'Creation date unknown'}
                    </p>
                  </div>
                </div>

                <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
                  <span className="text-[13px] font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                    Open workspace
                  </span>
                  <ArrowUpRight
                    aria-hidden="true"
                    className="h-4 w-4 text-muted-foreground transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent-strong"
                  />
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <Dialog
        open={isDialogOpen}
        onClose={closeDialog}
        title="Create a workspace"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A workspace holds your bots, knowledge, and conversations.
          </p>

          {createError && (
            <div className="rounded-lg border border-destructive/20 bg-error-bg px-3 py-2 text-sm text-error-bg-foreground">
              {createError}
            </div>
          )}

          <Input
            id="workspace-name"
            label="Workspace name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Customer Support"
            required
          />

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              onClick={closeDialog}
            >
              Cancel
            </Button>
            <Button type="submit" loading={creating}>
              Create workspace
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function HomeLoading() {
  return (
    <>
      <PageHeader title="Your Workspaces" description="Loading your workspaces…" />
      <WorkspaceGridSkeleton />
    </>
  );
}

function WorkspaceGridSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading workspaces"
      className="grid grid-cols-1 gap-4 md:grid-cols-3"
    >
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="flex min-h-[124px] flex-col rounded-xl border border-border bg-card p-4 sm:min-h-[140px] sm:p-5"
        >
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-2 pt-1">
              <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
            </div>
          </div>
          <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
            <div className="h-4 w-4 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-xl border border-destructive/20 bg-error-bg px-6 py-12 text-center">
      <h2 className="text-base font-semibold text-foreground">
        Workspaces didn&apos;t load
      </h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-error-bg-foreground">
        {message}
      </p>
      <Button variant="secondary" className="mt-5" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function EmptyWorkspaces({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-xl border border-border bg-card px-6 py-16 text-center">
      <h2 className="text-base font-semibold text-foreground">
        Create your first workspace
      </h2>
      <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">
        Workspaces hold your bots, knowledge, and conversations.
      </p>
      <Button className="mt-6" onClick={onCreate}>
        <Plus className="h-4 w-4" />
        Create workspace
      </Button>
    </div>
  );
}
