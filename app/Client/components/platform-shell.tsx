'use client';

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Route } from 'next';
import {
  Activity,
  Cpu,
  FlaskConical,
  FolderOpen,
  LayoutDashboard,
  Menu,
  Shield,
  SlidersHorizontal,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AccountMenu } from '@/components/account-menu';
import { Breadcrumbs, type BreadcrumbSegment } from '@/components/breadcrumbs';
import { useAuth } from '@/lib/auth-context';
import { PLATFORM_PERMISSIONS, type PlatformPermission } from '@/lib/permissions';

interface PlatformNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission?: PlatformPermission;
  /** The overview is only active on its exact route; the others own their subtree. */
  exact?: boolean;
}

const PLATFORM_NAV: { title: string; items: PlatformNavItem[] }[] = [
  {
    title: 'Platform',
    items: [
      {
        href: '/platform',
        label: 'Overview',
        icon: LayoutDashboard,
        exact: true,
      },
      { href: '/platform/users', label: 'Users', icon: Users },
      {
        href: '/platform/workspaces',
        label: 'Workspaces',
        icon: FolderOpen,
      },
      { href: '/platform/system', label: 'System', icon: Activity },
      {
        href: '/platform/settings',
        label: 'Settings',
        icon: SlidersHorizontal,
      },
    ],
  },
  {
    title: 'AI',
    items: [
      { href: '/platform/models', label: 'Models', icon: Cpu },
      {
        href: '/platform/ai-lab',
        label: 'AI Lab',
        icon: FlaskConical,
        permission: PLATFORM_PERMISSIONS.AI_OPERATE,
      },
    ],
  },
];

function isActive(pathname: string, item: PlatformNavItem) {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * The chrome for the platform administration area.
 *
 * Platform routes are a separate domain from a workspace, but they share the same
 * navigation language: a fixed rail, the account at the foot, and one content column.
 * Keeping that chrome here means an owner who follows Platform from a workspace rail
 * arrives on a page that still looks like the same product.
 */
export function PlatformShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { hasPermission } = useAuth();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerHasOpened = useRef(false);

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

  const currentItem = PLATFORM_NAV.flatMap((group) => group.items).find(
    (item) => item.href !== '/platform' && isActive(pathname, item),
  );

  const segments: BreadcrumbSegment[] = [
    { label: 'Home', href: '/home' },
    { label: 'Platform', href: '/platform' },
  ];
  if (currentItem) {
    segments.push({ label: currentItem.label });
  }

  const nav = (
    <PlatformSidebar
      pathname={pathname}
      hasPermission={hasPermission}
      onNavigate={() => setDrawerOpen(false)}
    />
  );

  return (
    <div className="min-h-screen bg-ground">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-card px-3 lg:hidden">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open platform navigation"
          aria-expanded={drawerOpen}
          aria-controls="platform-shell-navigation"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Menu aria-hidden="true" className="h-[18px] w-[18px]" />
        </button>
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-bg text-accent-bg-foreground"
          >
            <Shield className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-sm font-semibold tracking-tight text-foreground">
            Platform admin
          </span>
        </div>
      </header>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-card lg:block">
        {nav}
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
          id="platform-shell-navigation"
          role="dialog"
          aria-modal="true"
          aria-label="Platform navigation"
          inert={!drawerOpen}
          className={`absolute inset-y-0 left-0 flex w-72 flex-col border-r border-border bg-card transition-transform duration-200 motion-reduce:transition-none ${
            drawerOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <button
            ref={closeButtonRef}
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close platform navigation"
            className="absolute right-3 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
          {nav}
        </aside>
      </div>

      <div className="lg:pl-60">
        <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
          <Breadcrumbs segments={segments} />
          <div className="mt-5">{children}</div>
        </main>
      </div>
    </div>
  );
}

function PlatformSidebar({
  pathname,
  hasPermission,
  onNavigate,
}: {
  pathname: string;
  hasPermission: (permission: PlatformPermission) => boolean;
  onNavigate?: () => void;
}) {
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
        <div className="flex items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-bg text-accent-bg-foreground"
          >
            <Shield className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-foreground">
              Platform admin
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              Cross-tenant controls
            </p>
          </div>
        </div>
      </div>

      <nav
        aria-label="Platform"
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
      >
        {PLATFORM_NAV.map((group, index) => {
          const items = group.items.filter(
            (item) =>
              !item.permission || hasPermission(item.permission),
          );

          if (items.length === 0) return null;

          return (
            <div key={group.title} className={index > 0 ? 'mt-4' : undefined}>
              <p className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">
                {group.title}
              </p>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(pathname, item);

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href as Route}
                        onClick={onNavigate}
                        aria-current={active ? 'page' : undefined}
                        className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                          active
                            ? 'bg-sidebar-active font-medium text-sidebar-active-foreground hover:bg-sidebar-active'
                            : 'text-sidebar-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">
                          {item.label}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-border p-3">
        <AccountMenu
          variant="sidebar"
          onNavigate={onNavigate}
          showWorkspaceLinks={false}
        />
      </div>
    </div>
  );
}
