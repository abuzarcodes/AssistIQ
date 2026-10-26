import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const navigation = vi.hoisted(() => ({
  pathname: '/platform/models',
  replace: vi.fn(),
}));

const auth = vi.hoisted(() => ({
  user: {
    id: 'owner-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    platformRole: 'PLATFORM_OWNER',
  },
  hasPermission: vi.fn(() => true),
  logout: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: auth.user,
    platformRole: 'PLATFORM_OWNER',
    isPlatformOwner: true,
    hasPermission: auth.hasPermission,
    logout: auth.logout,
  }),
}));

const { ThemeProvider } = await import('@/lib/theme-context');
const { PlatformShell } = await import('@/components/platform-shell');

beforeEach(() => {
  vi.clearAllMocks();
  auth.hasPermission.mockReturnValue(true);
  navigation.pathname = '/platform/models';
  window.localStorage.setItem('assistiq_theme', 'system');
  document.documentElement.classList.remove('dark');
});

describe('platform shell navigation', () => {
  it('offers platform owners every platform section on the shared shell', () => {
    render(
      <ThemeProvider>
        <PlatformShell>
          <p>Models content</p>
        </PlatformShell>
      </ThemeProvider>,
    );

    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      '/platform',
    );
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute(
      'href',
      '/platform/users',
    );
    expect(screen.getByRole('link', { name: 'Workspaces' })).toHaveAttribute(
      'href',
      '/platform/workspaces',
    );
    expect(screen.getByRole('link', { name: 'System' })).toHaveAttribute(
      'href',
      '/platform/system',
    );
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/platform/settings',
    );
    expect(screen.getByRole('link', { name: 'AI Lab' })).toHaveAttribute(
      'href',
      '/platform/ai-lab',
    );
    expect(screen.getAllByRole('link', { name: 'Models' })[0]).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('Models content')).toBeInTheDocument();
  });

  it('hides AI Lab when the owner lacks the AI permission', () => {
    auth.hasPermission.mockReturnValue(false);

    render(
      <ThemeProvider>
        <PlatformShell>
          <p>Users content</p>
        </PlatformShell>
      </ThemeProvider>,
    );

    expect(screen.queryByRole('link', { name: 'AI Lab' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Users' })).toBeInTheDocument();
  });
});
