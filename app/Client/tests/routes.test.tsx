import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

/**
 * CP11 — root route behaviour.
 *
 * `/` is a redirect only: it must wait for the auth check, then send a signed-in user to
 * the global Home and an anonymous visitor to Login.
 */

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
}));

const authState = vi.hoisted(() => ({
  user: null as { id: string; name: string; email: string } | null,
  loading: true,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => authState,
}));

const { default: RootPage } = await import('@/app/page');

beforeEach(() => {
  vi.clearAllMocks();
  authState.loading = true;
  authState.user = null;
});

describe('root redirect', () => {
  it('sends an anonymous visitor to login once the auth check settles', async () => {
    authState.loading = false;
    authState.user = null;

    render(<RootPage />);

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/login'));
  });

  it('sends a signed-in user to the global Home', async () => {
    authState.loading = false;
    authState.user = { id: 'user-1', name: 'Ada', email: 'ada@example.com' };

    render(<RootPage />);

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/home'));
  });

  it('does not redirect while authentication is still loading', () => {
    render(<RootPage />);

    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
