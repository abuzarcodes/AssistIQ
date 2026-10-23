import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';

/**
 * CP11 — Global Home.
 *
 * Home is the only route that lists every workspace and the entry point for creating
 * one. These tests cover the real page (not a harness): the list is populated from the
 * API, an empty account gets the first-workspace state, and creation updates the list,
 * closes the dialog and announces the result.
 */

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
}));

const listWorkspaces = vi.hoisted(() => vi.fn());
const createWorkspace = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api/workspaces', () => ({
  listWorkspaces,
  createWorkspace,
}));

const { default: HomePage } = await import('@/app/home/page');

const workspace = (id: string, name: string, createdAt: string) => ({
  id,
  name,
  ownerId: 'user-1',
  createdAt,
  updatedAt: createdAt,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Global Home', () => {
  it('lists the current user workspaces with links into each workspace', async () => {
    listWorkspaces.mockResolvedValue([
      workspace('ws-old', 'Older Workspace', '2026-01-01T00:00:00.000Z'),
      workspace('ws-new', 'Newest Workspace', '2026-06-01T00:00:00.000Z'),
    ]);

    render(
      <ToastProvider>
        <HomePage />
      </ToastProvider>,
    );

    expect(
      await screen.findByRole('heading', { name: 'Your Workspaces' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('2 workspaces')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Newest Workspace/ }),
    ).toHaveAttribute('href', '/w/ws-new');
    expect(
      screen.getByRole('link', { name: /Older Workspace/ }),
    ).toHaveAttribute('href', '/w/ws-old');
  });

  it('shows the first-workspace state when the account has none', async () => {
    listWorkspaces.mockResolvedValue([]);

    render(
      <ToastProvider>
        <HomePage />
      </ToastProvider>,
    );

    expect(
      await screen.findByRole('heading', { name: 'Create your first workspace' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No workspaces yet')).toBeInTheDocument();
  });

  it('creates a workspace, closes the dialog and shows it in the list', async () => {
    listWorkspaces.mockResolvedValue([
      workspace('ws-1', 'Acme Support', '2026-01-01T00:00:00.000Z'),
    ]);
    createWorkspace.mockResolvedValue(
      workspace('ws-2', 'Fresh Workspace', '2026-06-01T00:00:00.000Z'),
    );

    render(
      <ToastProvider>
        <HomePage />
      </ToastProvider>,
    );

    await screen.findByRole('link', { name: /Acme Support/ });
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    const dialog = screen.getByRole('dialog', { name: 'Create a workspace' });
    fireEvent.change(within(dialog).getByLabelText('Workspace name'), {
      target: { value: 'Fresh Workspace' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Create workspace' }),
    );

    expect(await screen.findByText('Workspace created')).toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: /Fresh Workspace/ }),
    ).toHaveAttribute('href', '/w/ws-2');
    expect(createWorkspace).toHaveBeenCalledWith('Fresh Workspace');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
