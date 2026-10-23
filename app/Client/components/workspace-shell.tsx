'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Route } from 'next';
import {
  Bot,
  Cpu,
  FlaskConical,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Shield,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Breadcrumbs, type BreadcrumbSegment } from '@/components/breadcrumbs';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { PLATFORM_PERMISSIONS } from '@/lib/permissions';
import { useWorkspace } from '@/lib/workspace-context';
import type { WorkspaceDetail } from '@/lib/api/workspaces';

function initialOf(value: string) {
  return value.trim().charAt(0).toUpperCase() || '?';
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const { workspace, workspaceId, error, reload, pageBreadcrumbs } =
    useWorkspace();
  const pathname = usePathname();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerHasOpened = useRef(false);

  // Slide the drawer with a transform rather than mounting it only when open, so
  // closing animates too. `inert` keeps the hidden controls out of the tab order.
  useEffect(() => {
    if (!drawerOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;

      const focusables = [
        ...drawerRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.getClientRects().length > 0);

      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (drawerOpen) {
      drawerHasOpened.current = true;
      closeButtonRef.current?.focus();
    } else if (drawerHasOpened.current) {
      drawerHasOpened.current = false;
      menuButtonRef.current?.focus();
    }
  }, [drawerOpen]);

  if (!workspace) {
    if (error) {
      return <WorkspaceErrorState message={error} onRetry={reload} />;
    }
    return <WorkspaceShellSkeleton />;
  }

  const base = `/w/${workspaceId}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : '';
  const segments: BreadcrumbSegment[] = [
    { label: 'Home', href: '/home' },
    { label: workspace.name, href: base },
  ];

  const isInboxRoute = rest === '/inbox' || rest.startsWith('/inbox/');

  if (rest === '/bots' || rest.startsWith('/bots/')) {
    segments.push({ label: 'Bots', href: `${base}/bots` });
  } else if (isInboxRoute) {
    segments.push({ label: 'Support Inbox', href: `${base}/inbox` });
  }

  segments.push(...pageBreadcrumbs);

  return (
    <div className="min-h-screen bg-ground">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-card px-3 lg:hidden">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open workspace navigation"
          aria-expanded={drawerOpen}
          aria-controls="workspace-navigation-drawer"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Menu aria-hidden="true" className="h-[18px] w-[18px]" />
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent text-[10px] font-bold leading-none text-accent-foreground"
          >
            A
          </span>
          <span className="truncate text-sm font-semibold tracking-tight text-foreground">
            {workspace.name}
          </span>
        </div>
      </header>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-card lg:block">
        <SidebarContent
          workspace={workspace}
          workspaceId={workspaceId}
          pathname={pathname}
        />
      </aside>

      <div
        className={`fixed inset-0 z-50 lg:hidden ${
          drawerOpen ? '' : 'pointer-events-none'
        }`}
        aria-hidden={!drawerOpen}
      >
        <div
          aria-hidden="true"
          onClick={() => setDrawerOpen(false)}
          className={`absolute inset-0 bg-[var(--overlay)] transition-opacity duration-200 motion-reduce:transition-none ${
            drawerOpen ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <aside
          ref={drawerRef}
          id="workspace-navigation-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Workspace navigation"
          inert={!drawerOpen}
          className={`absolute inset-y-0 left-0 flex w-72 flex-col border-r border-border bg-card transition-transform duration-200 motion-reduce:transition-none ${
            drawerOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close workspace navigation"
            className="absolute right-3 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
          <SidebarContent
            workspace={workspace}
            workspaceId={workspaceId}
            pathname={pathname}
            onNavigate={() => setDrawerOpen(false)}
          />
        </aside>
      </div>

      <div className="lg:pl-60">
        {isInboxRoute ? (
          <main className="w-full">
            <div className="px-4 pt-4 sm:px-6 lg:px-8">
              <Breadcrumbs segments={segments} />
            </div>
            <div className="px-4 pb-4 pt-4 sm:px-6 lg:px-8">{children}</div>
          </main>
        ) : (
          <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
            <Breadcrumbs segments={segments} />
            <div className="mt-5">{children}</div>
          </main>
        )}
      </div>
    </div>
  );
}

function SidebarContent({
  workspace,
  workspaceId,
  pathname,
  onNavigate,
}: {
  workspace: WorkspaceDetail;
  workspaceId: string;
  pathname: string;
  onNavigate?: () => void;
}) {
  const { user, isPlatformOwner, hasPermission, logout } = useAuth();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const base = `/w/${workspaceId}`;
  const isDashboard = pathname === base;
  const isBots =
    pathname === `${base}/bots` || pathname.startsWith(`${base}/bots/`);
  const isInbox =
    pathname === `${base}/inbox` || pathname.startsWith(`${base}/inbox/`);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    onNavigate?.();
    await logout();
    router.replace('/login');
  }

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex h-16 shrink-0 items-center border-b border-border px-4">
        <Link
          href="/home"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-bold leading-none text-accent-foreground"
          >
            A
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-foreground">
            AssistIQ
          </span>
        </Link>
      </div>

      <div className="shrink-0 px-3 pb-3 pt-3">
        <WorkspaceSwitcher
          currentWorkspace={workspace}
          workspaceId={workspaceId}
          onNavigate={onNavigate}
        />
      </div>

      <nav
        aria-label="Workspace"
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
      >
        <p className="px-2.5 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">
          Workspace
        </p>
        <ul className="space-y-0.5">
          <li>
            <NavItem
              href={base}
              label="Dashboard"
              icon={LayoutDashboard}
              active={isDashboard}
              onClick={onNavigate}
            />
          </li>
          <li>
            <NavItem
              href={`${base}/bots`}
              label="Bots"
              icon={Bot}
              active={isBots}
              onClick={onNavigate}
            />
          </li>
          <li>
            <NavItem
              href={`${base}/inbox`}
              label="Support Inbox"
              icon={Inbox}
              active={isInbox}
              onClick={onNavigate}
            />
          </li>
          <CreatorSuiteItem />
        </ul>

        {isPlatformOwner && (
          <>
            <div className="mx-2.5 my-3 h-px bg-border" />
            <p className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">
              Platform
            </p>
            <ul className="space-y-0.5">
              <li>
                <NavItem
                  href="/platform"
                  label="Platform"
                  icon={Shield}
                  active={pathname === '/platform'}
                  onClick={onNavigate}
                />
              </li>
              <li>
                <NavItem
                  href="/platform/models"
                  label="Models"
                  icon={Cpu}
                  active={
                    pathname === '/platform/models' ||
                    pathname.startsWith('/platform/models/')
                  }
                  onClick={onNavigate}
                />
              </li>
              {hasPermission(PLATFORM_PERMISSIONS.AI_OPERATE) && (
                <li>
                  <NavItem
                    href="/platform/ai-lab"
                    label="AI Lab"
                    icon={FlaskConical}
                    active={
                      pathname === '/platform/ai-lab' ||
                      pathname.startsWith('/platform/ai-lab/')
                    }
                    onClick={onNavigate}
                  />
                </li>
              )}
            </ul>
          </>
        )}
      </nav>

      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-center gap-2.5 px-1 pb-2">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-bg text-xs font-semibold text-accent-bg-foreground"
          >
            {initialOf(user?.name ?? '')}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-foreground">
              {user?.name}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {user?.email}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          disabled={signingOut}
          className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <LogOut aria-hidden="true" className="h-4 w-4" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </div>
  );
}

function CreatorSuiteItem() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLLIElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const noteId = useId();

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
        buttonRef.current?.focus();
      }
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <li ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={noteId}
        title="Chatbot Creator Suite - Coming Soon"
        className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Sparkles aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Creator Suite</span>
        <span className="shrink-0 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium leading-none text-muted-foreground">
          Coming Soon
        </span>
      </button>
      {open && (
        <div
          id={noteId}
          role="status"
          className="mx-1 mt-1 rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground"
        >
          <span className="font-medium text-foreground">
            Chatbot Creator Suite is planned.
          </span>{' '}
          A guided builder for multi-step chatbot flows is coming soon. Nothing
          to set up yet.
        </div>
      )}
    </li>
  );
}

function NavItem({
  href,
  label,
  icon: Icon,
  active = false,
  onClick,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href as Route}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        active
          ? 'bg-sidebar-active font-medium text-sidebar-active-foreground hover:bg-sidebar-active'
          : 'text-sidebar-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </Link>
  );
}

function WorkspaceErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-ground px-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-sm font-bold leading-none text-accent-foreground"
        >
          A
        </span>
        <h1 className="mt-4 text-lg font-semibold tracking-tight text-foreground">
          We couldn&apos;t open this workspace
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={onRetry}>Try again</Button>
          <Button variant="secondary" onClick={() => router.push('/home')}>
            All workspaces
          </Button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceShellSkeleton() {
  return (
    <div className="min-h-screen bg-ground" role="status" aria-live="polite">
      <span className="sr-only">Loading workspace</span>
      <div aria-hidden="true">
        <header className="flex h-14 items-center gap-3 border-b border-border bg-card px-3 lg:hidden">
          <span className="h-9 w-9 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
          <span className="h-6 w-6 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
          <span className="h-4 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </header>

        <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-border bg-card lg:flex">
          <div className="flex h-16 items-center gap-2.5 border-b border-border px-4">
            <span className="h-8 w-8 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
            <span className="h-4 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
          <div className="p-3">
            <span className="block h-10 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
          </div>
          <div className="space-y-1.5 px-3">
            {[0, 1, 2, 3].map((row) => (
              <span
                key={row}
                className="block h-9 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
          <div className="mt-auto border-t border-border p-3">
            <div className="flex items-center gap-2.5 px-1 pb-2">
              <span className="h-8 w-8 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
              <div className="flex-1 space-y-1.5">
                <span className="block h-3 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                <span className="block h-2.5 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              </div>
            </div>
            <span className="block h-8 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
          </div>
        </aside>

        <div className="lg:pl-60">
          <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
            <span className="block h-3.5 w-56 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="mt-6 space-y-2">
              <span className="block h-8 w-64 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <span className="block h-3.5 w-80 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
            </div>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <span className="block h-32 animate-pulse rounded-xl border border-border bg-card motion-reduce:animate-none" />
              <span className="block h-32 animate-pulse rounded-xl border border-border bg-card motion-reduce:animate-none" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
