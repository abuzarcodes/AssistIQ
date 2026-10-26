'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'assistiq_theme';

interface ThemeSnapshot {
  mode: ThemeMode;
  resolvedTheme: ResolvedTheme;
}

interface ThemeContextValue extends ThemeSnapshot {
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const SERVER_SNAPSHOT: ThemeSnapshot = Object.freeze({
  mode: 'system',
  resolvedTheme: 'light',
});

const listeners = new Set<() => void>();
let currentSnapshot: ThemeSnapshot = SERVER_SNAPSHOT;
let memoryMode: ThemeMode = 'system';

function isThemeMode(value: string | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'system';
  } catch {
    // Storage can be unavailable in private browsing. The in-memory choice still works.
    return memoryMode;
  }
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return prefersDark() ? 'dark' : 'light';
}

/**
 * Writes the resolved theme to the document. The class lives on <html> rather than on a
 * wrapper so the CSS variables and Tailwind's `dark:` variant see one state, and
 * `color-scheme` makes native controls (scrollbars, form fields) match.
 */
function paint(resolvedTheme: ResolvedTheme) {
  const root = document.documentElement;

  root.classList.toggle('dark', resolvedTheme === 'dark');
  root.style.colorScheme = resolvedTheme;
}

function refresh() {
  const mode = readStoredMode();
  const resolvedTheme = resolve(mode);

  paint(resolvedTheme);

  if (
    mode === currentSnapshot.mode &&
    resolvedTheme === currentSnapshot.resolvedTheme
  ) {
    return;
  }

  currentSnapshot = { mode, resolvedTheme };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  // The blocking script in the root layout painted the stored theme before hydration.
  // This call brings the React snapshot in line with that paint.
  refresh();

  function handleStorage(event: StorageEvent) {
    if (event.key === THEME_STORAGE_KEY) refresh();
  }

  function handleSystemChange() {
    if (readStoredMode() === 'system') refresh();
  }

  window.addEventListener('storage', handleStorage);

  const query =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
  query?.addEventListener?.('change', handleSystemChange);

  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', handleStorage);
    query?.removeEventListener?.('change', handleSystemChange);
  };
}

function getSnapshot() {
  return currentSnapshot;
}

function getServerSnapshot() {
  return SERVER_SNAPSHOT;
}

/**
 * Owns the light/dark/system choice for the whole app.
 *
 * The choice is local to the browser: it is an appearance preference, not account data.
 * `useSyncExternalStore` is the right bridge here because the source of truth (storage
 * plus the device colour preference) lives outside React and can change without a click.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setMode = useCallback((next: ThemeMode) => {
    memoryMode = next;

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The theme still applies for this session when storage is unavailable.
    }

    refresh();
  }, []);

  const value = useMemo(
    () => ({ ...snapshot, setMode }),
    [snapshot, setMode],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }

  return context;
}
