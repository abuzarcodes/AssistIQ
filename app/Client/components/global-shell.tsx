import Link from 'next/link';
import type { ReactNode } from 'react';
import { AccountMenu } from '@/components/account-menu';

/**
 * The chrome for the global (pre-workspace) area. One quiet bar with the product
 * on the left and the account on the right; everything else is the page's own
 * content. Workspace navigation lives in the workspace shell, not here.
 */
export function GlobalShell({ children }: { children: ReactNode }) {
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

          <AccountMenu />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        {children}
      </main>
    </div>
  );
}
