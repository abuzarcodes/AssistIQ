"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FolderOpen,
  FlaskConical,
  Shield,
  Cpu,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import {
  PLATFORM_PERMISSIONS,
  type PlatformPermission,
} from "@/lib/permissions";
import { useEffect, useRef, useState } from "react";

/**
 * Each item declares the permission it needs. `null` means "any signed-in user".
 * Filtering by permission rather than by role keeps the nav in step with the server's
 * model: a new role only needs a permission set, not an edit to this list.
 */
const navItems: {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission: PlatformPermission | null;
}[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    permission: null,
  },
  {
    href: "/dashboard/workspaces",
    label: "Workspaces",
    icon: FolderOpen,
    permission: null,
  },
  {
    href: "/platform",
    label: "Platform",
    icon: Shield,
    permission: PLATFORM_PERMISSIONS.PLATFORM_ADMIN,
  },
  {
    href: "/platform/models",
    label: "Models",
    icon: Cpu,
    permission: PLATFORM_PERMISSIONS.PLATFORM_ADMIN,
  },
  {
    href: "/platform/ai-lab",
    label: "AI Lab",
    icon: FlaskConical,
    permission: PLATFORM_PERMISSIONS.AI_OPERATE,
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout, hasPermission } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerHasOpened = useRef(false);

  useEffect(() => {
    if (!mobileOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMobileOpen(false);
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
  }, [mobileOpen]);

  useEffect(() => {
    if (mobileOpen) {
      drawerHasOpened.current = true;
      closeButtonRef.current?.focus();
    } else if (drawerHasOpened.current) {
      drawerHasOpened.current = false;
      menuButtonRef.current?.focus();
    }
  }, [mobileOpen]);

  // Permission-gated items are dropped entirely for users who lack the permission —
  // the server would reject the calls behind them anyway, so showing them would only
  // offer a dead end.
  const visibleItems = navItems.filter(
    (item) => item.permission === null || hasPermission(item.permission),
  );

  const isActive = (href: string) => {
    if (href === "/dashboard" || href === "/platform") return pathname === href;
    return pathname.startsWith(href);
  };

  const nav = (
    <>
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-sidebar-border">
        <div className="h-7 w-7 rounded-lg bg-accent flex items-center justify-center">
          <span className="text-xs font-bold text-accent-foreground">A</span>
        </div>
        <span className="text-sm font-semibold text-foreground tracking-tight">
          AssistIQ
        </span>
      </div>

      <nav aria-label="Platform" className="flex-1 px-3 py-3 space-y-0.5">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                active
                  ? "bg-sidebar-active text-sidebar-active-foreground"
                  : "text-sidebar-foreground hover:bg-muted"
              }`}
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border px-4 py-3">
        <div className="flex items-center gap-2.5 mb-2">
          <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center">
            <span className="text-xs font-medium text-muted-foreground">
              {user?.name?.charAt(0)?.toUpperCase() || "?"}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground truncate">
              {user?.name}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {user?.email}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={async () => {
            await logout();
            setMobileOpen(false);
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 cursor-pointer"
        >
          <LogOut aria-hidden="true" className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile toggle */}
      <button
        ref={menuButtonRef}
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open platform navigation"
        aria-expanded={mobileOpen}
        aria-controls="platform-navigation-drawer"
        className="fixed top-3 left-3 z-40 rounded-lg border border-border bg-card p-2 shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 lg:hidden cursor-pointer"
      >
        <Menu aria-hidden="true" className="h-4 w-4" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        ref={drawerRef}
        id="platform-navigation-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Platform navigation"
        inert={!mobileOpen}
        className={`fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-200 lg:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button
          ref={closeButtonRef}
          type="button"
          onClick={() => setMobileOpen(false)}
          aria-label="Close platform navigation"
          className="absolute top-3 right-3 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 cursor-pointer"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
        {nav}
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex lg:w-60 lg:flex-col lg:fixed lg:inset-y-0 bg-sidebar border-r border-sidebar-border">
        {nav}
      </aside>
    </>
  );
}
