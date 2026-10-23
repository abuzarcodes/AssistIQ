import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Breadcrumbs } from '@/components/breadcrumbs';

/**
 * CP11 — workspace navigation.
 *
 * The switcher is the only way to move between workspaces without going back to Home.
 * It must keep the current section, close the menu, and do nothing when the current
 * workspace is selected. Breadcrumbs must expose a real trail while leaving the final
 * segment as the current page, not a link.
 */

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));

const location = vi.hoisted(() => ({ pathname: '/w/ws-1/bots' }));

const workspaceState = vi.hoisted(() => ({
  workspaces: [] as Array<Record<string, unknown>>,
  workspacesLoading: false,
  workspacesError: null as string | null,
  loadWorkspaces: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => location.pathname,
  useRouter: () => navigation,
}));

vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => workspaceState,
}));

const { WorkspaceSwitcher } = await import('@/components/workspace-switcher');

const currentWorkspace = {
  id: 'ws-1',
  name: 'Acme Support',
  ownerId: 'user-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const secondWorkspace = {
  id: 'ws-2',
  name: 'Beta Support',
  ownerId: 'user-1',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  location.pathname = '/w/ws-1/bots';
  workspaceState.workspaces = [currentWorkspace, secondWorkspace];
  workspaceState.workspacesLoading = false;
  workspaceState.workspacesError = null;
});

describe('WorkspaceSwitcher', () => {
  it('keeps the bots section when switching workspace', () => {
    render(
      <WorkspaceSwitcher
        currentWorkspace={currentWorkspace}
        workspaceId="ws-1"
      />,
    );

    const trigger = screen.getByRole('button', { name: /Acme Support/ });
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Beta Support/ }));

    expect(navigation.push).toHaveBeenCalledWith('/w/ws-2/bots');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps the inbox section when switching workspace', () => {
    location.pathname = '/w/ws-1/inbox';
    render(
      <WorkspaceSwitcher
        currentWorkspace={currentWorkspace}
        workspaceId="ws-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Acme Support/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Beta Support/ }));

    expect(navigation.push).toHaveBeenCalledWith('/w/ws-2/inbox');
  });

  it('closes without navigating when the current workspace is selected', () => {
    render(
      <WorkspaceSwitcher
        currentWorkspace={currentWorkspace}
        workspaceId="ws-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Acme Support/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Acme Support/ }));

    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('links back to the global workspace list', () => {
    render(
      <WorkspaceSwitcher
        currentWorkspace={currentWorkspace}
        workspaceId="ws-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Acme Support/ }));

    expect(
      screen.getByRole('menuitem', { name: 'All workspaces' }),
    ).toHaveAttribute('href', '/home');
  });
});

describe('Breadcrumbs', () => {
  it('renders links for ancestors and marks the last segment as the current page', () => {
    render(
      <Breadcrumbs
        segments={[
          { label: 'Home', href: '/home' },
          { label: 'Acme Support', href: '/w/ws-1' },
          { label: 'Bots', href: '/w/ws-1/bots' },
          { label: 'Helper', href: '/w/ws-1/bots/bot-1' },
        ]}
      />,
    );

    expect(
      screen.getByRole('navigation', { name: 'Breadcrumb' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'href',
      '/home',
    );
    expect(screen.getByRole('link', { name: 'Bots' })).toHaveAttribute(
      'href',
      '/w/ws-1/bots',
    );
    expect(
      screen.queryByRole('link', { name: 'Helper' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Helper')).toHaveAttribute('aria-current', 'page');
  });
});
