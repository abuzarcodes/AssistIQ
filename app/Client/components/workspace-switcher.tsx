'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import { Check, ChevronDown, LayoutGrid, Plus } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import type { Workspace } from '@/lib/api/workspaces';

function initialOf(name: string) {
  return name.trim().charAt(0).toUpperCase() || 'W';
}

/**
 * The workspace switcher keeps the section you are in. Switching from one
 * workspace's bot list lands on the other workspace's bot list; a bot detail route
 * falls back to the list because ids do not exist in the new workspace.
 */
function sectionFor(pathname: string, workspaceId: string) {
  const prefix = `/w/${workspaceId}`;
  const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';

  if (rest === '/bots' || rest.startsWith('/bots/')) return '/bots';
  if (rest === '/inbox' || rest.startsWith('/inbox/')) return '/inbox';
  return '';
}

export function WorkspaceSwitcher({
  currentWorkspace,
  workspaceId,
  onNavigate,
}: {
  currentWorkspace: Workspace;
  workspaceId: string;
  onNavigate?: () => void;
}) {
  const { workspaces, workspacesLoading, workspacesError, loadWorkspaces } =
    useWorkspace();
  const router = useRouter();
  const pathname = usePathname();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerId = useId();
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  function handleToggle() {
    const next = !open;
    setOpen(next);

    if (next && workspaces === null && !workspacesLoading) {
      void loadWorkspaces();
    }
  }

  function switchTo(nextWorkspaceId: string) {
    setOpen(false);

    if (nextWorkspaceId === workspaceId) return;

    const section = sectionFor(pathname, workspaceId);
    const href =
      section === '/bots'
        ? `/w/${nextWorkspaceId}/bots`
        : section === '/inbox'
          ? `/w/${nextWorkspaceId}/inbox`
          : `/w/${nextWorkspaceId}`;

    onNavigate?.();
    router.push(href as Route);
  }

  const items = useMemo(() => {
    const list = workspaces ? [...workspaces] : [];

    if (!list.some((workspace) => workspace.id === currentWorkspace.id)) {
      list.push(currentWorkspace);
    }

    return list.sort((a, b) => {
      if (a.id === currentWorkspace.id) return -1;
      if (b.id === currentWorkspace.id) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [workspaces, currentWorkspace]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        onClick={handleToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title={currentWorkspace.name}
        className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-bg text-[11px] font-semibold text-accent-bg-foreground"
        >
          {initialOf(currentWorkspace.name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
          {currentWorkspace.name}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
        >
          <div className="px-3 pb-1 pt-2.5">
            <p className="text-xs font-medium text-muted-foreground">Workspaces</p>
          </div>

          <div className="max-h-64 overflow-y-auto p-1.5">
            {workspacesLoading ? (
              <div aria-label="Loading workspaces" className="space-y-1 p-1">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="flex items-center gap-2.5 px-1.5 py-1.5">
                    <span className="h-6 w-6 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
                    <span className="h-3 w-28 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                  </div>
                ))}
              </div>
            ) : workspacesError ? (
              <div className="px-2 py-2">
                <p className="text-[13px] text-muted-foreground">{workspacesError}</p>
                <button
                  type="button"
                  onClick={() => void loadWorkspaces()}
                  className="mt-1.5 rounded-sm text-[13px] font-medium text-accent-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  Try again
                </button>
              </div>
            ) : (
              items.map((workspace) => {
                const isCurrent = workspace.id === workspaceId;

                return (
                  <button
                    key={workspace.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isCurrent}
                    onClick={() => switchTo(workspace.id)}
                    title={workspace.name}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                      isCurrent ? 'bg-muted' : 'hover:bg-muted'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold ${
                        isCurrent
                          ? 'bg-accent-bg text-accent-bg-foreground'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {initialOf(workspace.name)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                      {workspace.name}
                    </span>
                    {isCurrent && (
                      <Check
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 text-accent-strong"
                      />
                    )}
                  </button>
                );
              })
            )}
          </div>

          <div className="border-t border-border p-1.5">
            <Link
              role="menuitem"
              href="/home"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <LayoutGrid
                aria-hidden="true"
                className="h-4 w-4 text-muted-foreground"
              />
              All workspaces
            </Link>
            <Link
              role="menuitem"
              href="/home?create=true"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Plus aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
              Create workspace
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
