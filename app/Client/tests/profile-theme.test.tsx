import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const auth = vi.hoisted(() => ({
  user: {
    id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    platformRole: 'USER',
  },
  logout: vi.fn(),
}));

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: auth.user,
    platformRole: 'USER',
    isPlatformOwner: false,
    logout: auth.logout,
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

const { ThemeProvider } = await import('@/lib/theme-context');
const { default: ProfilePage } = await import('@/app/profile/page');
const { AccountMenu } = await import('@/components/account-menu');

let prefersDark = false;

beforeEach(() => {
  vi.clearAllMocks();
  prefersDark = false;
  window.localStorage.setItem('assistiq_theme', 'system');
  document.documentElement.classList.remove('dark');
  document.documentElement.style.colorScheme = '';

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe('theme preferences', () => {
  it('shows the three choices on the profile page and defaults to system', async () => {
    render(
      <ThemeProvider>
        <ProfilePage />
      </ThemeProvider>,
    );

    expect(
      screen.getByRole('heading', { name: 'Profile' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Appearance' }),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: /^System/ }),
      ).toHaveAttribute('aria-checked', 'true'),
    );
    expect(screen.getByRole('radio', { name: /^Light/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Dark/ })).toBeInTheDocument();
  });

  it('follows a dark device preference while in system mode', async () => {
    prefersDark = true;

    render(
      <ThemeProvider>
        <ProfilePage />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(document.documentElement).toHaveClass('dark'),
    );
    expect(
      screen.getByRole('radio', { name: /^System/ }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByText('Following your device — currently dark.'),
    ).toBeInTheDocument();
  });

  it('applies and stores a chosen theme immediately', async () => {
    render(
      <ThemeProvider>
        <ProfilePage />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('radio', { name: /^Dark/ }));

    await waitFor(() =>
      expect(document.documentElement).toHaveClass('dark'),
    );
    expect(window.localStorage.getItem('assistiq_theme')).toBe('dark');
    expect(screen.getByText('Dark theme selected.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /^Light/ }));

    await waitFor(() =>
      expect(document.documentElement).not.toHaveClass('dark'),
    );
    expect(window.localStorage.getItem('assistiq_theme')).toBe('light');
    expect(screen.getByText('Light theme selected.')).toBeInTheDocument();
  });

  it('offers Profile and the same theme choices in the account menu', async () => {
    render(
      <ThemeProvider>
        <AccountMenu />
      </ThemeProvider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Account menu for Ada Lovelace' }),
    );

    expect(screen.getByRole('menuitem', { name: 'Profile' })).toHaveAttribute(
      'href',
      '/profile',
    );
    expect(
      screen.getByRole('menuitemradio', { name: 'Dark' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Dark' }));

    await waitFor(() =>
      expect(document.documentElement).toHaveClass('dark'),
    );
    expect(
      screen.getByRole('menuitemradio', { name: 'Dark' }),
    ).toHaveAttribute('aria-checked', 'true');
  });
});
