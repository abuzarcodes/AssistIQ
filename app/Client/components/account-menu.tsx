'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  Check,
  ChevronDown,
  LayoutGrid,
  LogOut,
  Shield,
  UserRound,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useTheme } from '@/lib/theme-context';
import { THEME_OPTIONS } from '@/components/theme-options';

interface AccountMenuProps {
  /** `sidebar` anchors the menu above the account row instead of below a header. */
  variant?: 'header' | 'sidebar';
  /** Closes a mobile drawer after a navigation or sign-out. */
  onNavigate?: () => void;
  /** The global header keeps the workspace shortcuts; the app sidebars do not. */
  showWorkspaceLinks?: boolean;
}

function initialOf(name: string) {
  return name.trim().charAt(0).toUpperCase() || '?';
}

/**
 * The account surface shared by the global header and both sidebars.
 *
 * Theme lives here as a labelled set of three choices rather than a switch: a two-state
 * toggle cannot express "follow my device", and hiding that state is how a theme control
 * starts to feel bolted on. The profile page renders the same choices at a larger size.
 */
export function AccountMenu({
  variant = 'header',
  onNavigate,
  showWorkspaceLinks = true,
}: AccountMenuProps) {
  const { user, isPlatformOwner, logout } = useAuth();
  const { mode, setMode } = useTheme();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const themeLabelId = useId();

  const sidebar = variant === 'sidebar';

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

    function handleKeyDown(event: globalThis.KeyboardEvent) {
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

  function closeMenu() {
    setOpen(false);
    onNavigate?.();
  }

  async function handleSignOut() {
    if (signingOut) return;

    setSigningOut(true);
    closeMenu();

    await logout();
    router.replace('/login');
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const forward = event.key === 'ArrowDown';
    const backward = event.key === 'ArrowUp';

    if (!forward && !backward) return;

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"]',
      ),
    ).filter((element) => element.getClientRects().length > 0);

    if (items.length === 0) return;

    event.preventDefault();
    const currentIndex = items.indexOf(
      document.activeElement as HTMLElement,
    );
    const nextIndex =
      currentIndex === -1
        ? forward
          ? 0
          : items.length - 1
        : (currentIndex + (forward ? 1 : -1) + items.length) % items.length;

    items[nextIndex].focus();
  }

  const name = user?.name ?? '';
  const email = user?.email ?? '';

  return (
    <div
      ref={containerRef}
      className={`relative ${sidebar ? 'w-full' : ''}`}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name ? `Account menu for ${name}` : 'Account menu'}
        className={
          sidebar
            ? 'flex w-full items-center gap-2.5 rounded-lg px-1 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
            : 'flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'
        }
      >
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-bg text-xs font-semibold text-accent-bg-foreground"
        >
          {initialOf(name)}
        </span>

        {sidebar ? (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-foreground">
              {name}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {email}
            </span>
          </span>
        ) : (
          <span className="hidden max-w-[140px] truncate text-sm font-medium text-foreground sm:block">
            {name}
          </span>
        )}

        <ChevronDown
          aria-hidden="true"
          className={`shrink-0 text-muted-foreground transition-transform ${
            sidebar ? 'h-4 w-4' : 'h-3.5 w-3.5'
          } ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          onKeyDown={handleMenuKeyDown}
          className={`absolute z-50 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-xl border border-border bg-card p-1.5 shadow-lg ${
            sidebar
              ? 'bottom-full left-0 mb-2 w-64'
              : 'right-0 top-full mt-2 w-72'
          }`}
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-medium text-foreground">
              {name}
            </p>
            <p className="truncate text-xs text-muted-foreground">{email}</p>
          </div>

          <div className="my-1 h-px bg-border" />

          <Link
            role="menuitem"
            href="/profile"
            onClick={closeMenu}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <UserRound
              aria-hidden="true"
              className="h-4 w-4 text-muted-foreground"
            />
            Profile
          </Link>

          {!sidebar && showWorkspaceLinks && (
            <>
              <Link
                role="menuitem"
                href="/home"
                onClick={closeMenu}
                className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <LayoutGrid
                  aria-hidden="true"
                  className="h-4 w-4 text-muted-foreground"
                />
                All workspaces
              </Link>
              {isPlatformOwner && (
                <Link
                  role="menuitem"
                  href="/platform"
                  onClick={closeMenu}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <Shield
                    aria-hidden="true"
                    className="h-4 w-4 text-muted-foreground"
                  />
                  Platform admin
                </Link>
              )}
            </>
          )}

          <div className="my-1 h-px bg-border" />

          <div className="px-1.5 pb-1">
            <p
              id={themeLabelId}
              className="px-1 pb-1 pt-1.5 text-xs font-medium text-muted-foreground"
            >
              Appearance
            </p>
            <div
              role="group"
              aria-labelledby={themeLabelId}
              className="space-y-0.5"
            >
              {THEME_OPTIONS.map((option) => {
                const selected = option.value === mode;
                const Icon = option.icon;

                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => setMode(option.value)}
                    className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                      selected ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1">{option.label}</span>
                    {selected && (
                      <Check
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-accent-strong"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="my-1 h-px bg-border" />

          <button
            type="button"
            role="menuitem"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LogOut
              aria-hidden="true"
              className="h-4 w-4 text-muted-foreground"
            />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
