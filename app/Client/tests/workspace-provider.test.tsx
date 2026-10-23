import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import {
  WorkspaceProvider,
  useWorkspace,
} from '@/lib/workspace-context';

/**
 * CP11 — invalid workspace routes.
 *
 * A route id that no longer exists (or is not visible to the caller) is a navigation
 * dead end: the shell has nothing to render and must replace the URL with Home. A
 * transient failure is different — it stays on the route and offers a retry.
 */

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
}));

const getWorkspace = vi.hoisted(() => vi.fn());
const listWorkspaces = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

vi.mock('@/lib/api/workspaces', () => ({
  getWorkspace,
  listWorkspaces,
}));

const detail = {
  id: 'ws-1',
  name: 'Acme Support',
  ownerId: 'user-1',
  viewerRole: 'OWNER' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function Probe() {
  const { workspace, loading, error, reload } = useWorkspace();

  return (
    <div>
      <p>{loading ? 'loading' : error ?? workspace?.name ?? 'none'}</p>
      {error && (
        <button type="button" onClick={reload}>
          Try again
        </button>
      )}
    </div>
  );
}

function renderRoute(workspaceId = 'ws-1') {
  return render(
    <ToastProvider>
      <WorkspaceProvider workspaceId={workspaceId}>
        <Probe />
      </WorkspaceProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listWorkspaces.mockResolvedValue([]);
});

describe('WorkspaceProvider route failures', () => {
  it('redirects to Home and explains a missing workspace', async () => {
    getWorkspace.mockRejectedValue(new ApiError('Workspace not found', 404));

    renderRoute('missing');

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent('That workspace could not be found.');
    expect(navigation.replace).toHaveBeenCalledWith('/home');
  });

  it('redirects to Home when the workspace is not visible to the caller', async () => {
    getWorkspace.mockRejectedValue(new ApiError('Forbidden', 403));

    renderRoute('private');

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/home'));
    expect(screen.queryByText('Forbidden')).not.toBeInTheDocument();
  });

  it('stays on the route and retries after a transient failure', async () => {
    getWorkspace
      .mockRejectedValueOnce(new ApiError('Server unavailable', 500))
      .mockResolvedValueOnce(detail);

    renderRoute();

    expect(
      await screen.findByText(
        'We could not load this workspace. Check your connection and try again.',
      ),
    ).toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Acme Support')).toBeInTheDocument();
    expect(getWorkspace).toHaveBeenCalledTimes(2);
  });
});
