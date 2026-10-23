'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, LayoutGrid, LogOut, Shield } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';

/**
 * The chrome for the global (pre-workspace) area. One quiet bar with the product
 * on the left and the account on the right; everything else is the page's own
 * content. Workspace navigation lives in the workspace shell, not here.
 */
export function GlobalShell({ children }: { children: ReactNode }) {
  const { user, isPlatformOwner, logout } = useAuth();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  async function handleSignOut() {
    setMenuOpen(false);
    await logout();
    router.replace('/login');
  }

  const initial = user?.name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="min-h-screen bg-ground">
      <header className="sticky top-0 z-30 border-b border-border bg-background">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link
            href="/home"
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

          <div ref={accountRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span
                aria-hidden="true"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-bg text-xs font-semibold text-accent-bg-foreground"
              >
                {initial}
              </span>
              <span className="hidden max-w-[140px] truncate text-sm font-medium text-foreground sm:block">
                {user?.name}
              </span>
              <ChevronDown
                aria-hidden="true"
                className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${menuOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {menuOpen && (
              <div
                role="menu"
                aria-label="Account"
                className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-border bg-card p-1.5 shadow-lg"
              >
                <div className="px-2.5 py-2">
                  <p className="truncate text-sm font-medium text-foreground">{user?.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
                </div>
                <div className="my-1 h-px bg-border" />
                <Link
                  role="menuitem"
                  href="/home"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted"
                >
                  <LayoutGrid aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                  All workspaces
                </Link>
                {isPlatformOwner && (
                  <Link
                    role="menuitem"
                    href="/platform"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted"
                  >
                    <Shield aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                    Platform admin
                  </Link>
                )}
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleSignOut}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
                >
                  <LogOut aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        {children}
      </main>
    </div>
  );
}
