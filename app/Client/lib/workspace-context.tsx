'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api-client';
import {
  getWorkspace,
  listWorkspaces,
  type Workspace,
  type WorkspaceDetail,
  type WorkspaceRole,
} from '@/lib/api/workspaces';
import {
  hasWorkspacePermission,
  type WorkspacePermission,
} from '@/lib/permissions';
import { useToast } from '@/components/ui/toast';

/**
 * A route-owned segment appended to the shell's breadcrumb trail. The shell owns
 * Home, the workspace and the section; a detail page supplies the record's name.
 */
export interface WorkspaceBreadcrumb {
  label: string;
  href?: string;
}

interface WorkspaceContextValue {
  /** The workspace id from the URL. */
  workspaceId: string;
  /** The loaded workspace, or `null` while loading / after a failure. */
  workspace: WorkspaceDetail | null;
  /** The caller's role in this workspace. Unknown until the detail request lands. */
  viewerRole: WorkspaceRole | undefined;
  loading: boolean;
  error: string | null;
  /** Retry the workspace request without leaving the route. */
  reload: () => void;
  /** Workspace-domain permission check for the loaded role. */
  hasPermission: (permission: WorkspacePermission) => boolean;

  /**
   * Breadcrumb segments owned by the current page. The shell renders these after
   * its route-derived trail, so a bot page can add the bot's name without
   * duplicating Home / Workspace / Bots.
   */
  pageBreadcrumbs: WorkspaceBreadcrumb[];
  setPageBreadcrumbs: (breadcrumbs: WorkspaceBreadcrumb[]) => void;

  /**
   * The switcher's list is lazy: it is only requested the first time the menu opens.
   * `null` means "not requested yet"; an empty array is a real, empty result.
   */
  workspaces: Workspace[] | null;
  workspacesLoading: boolean;
  workspacesError: string | null;
  loadWorkspaces: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const handleFailure = useCallback(
    (caught: unknown) => {
      // A missing workspace and one the caller cannot see are the same answer from
      // the shell's point of view: neither has a place in the navigation.
      if (caught instanceof ApiError && caught.status === 404) {
        toast('That workspace could not be found.', 'error');
        router.replace('/home');
        return;
      }

      if (caught instanceof ApiError && caught.status === 403) {
        // ApiErrorBridge already surfaces the server's permission message.
        router.replace('/home');
        return;
      }

      setError(
        'We could not load this workspace. Check your connection and try again.',
      );
      setLoading(false);
    },
    [router, toast],
  );

  useEffect(() => {
    let cancelled = false;

    getWorkspace(workspaceId)
      .then((data) => {
        if (cancelled) return;
        setWorkspace(data);
        setError(null);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (!cancelled) handleFailure(caught);
      });

    return () => {
      cancelled = true;
      // Invalidate an in-flight response if the provider goes away or the id changes.
      requestRef.current += 1;
    };
  }, [workspaceId, handleFailure]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);

    const request = ++requestRef.current;
    getWorkspace(workspaceId)
      .then((data) => {
        if (request !== requestRef.current) return;
        setWorkspace(data);
        setError(null);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (request === requestRef.current) handleFailure(caught);
      });
  }, [workspaceId, handleFailure]);

  const [pageBreadcrumbs, setPageBreadcrumbs] = useState<WorkspaceBreadcrumb[]>(
    [],
  );

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);

  const loadWorkspaces = useCallback(async () => {
    setWorkspacesLoading(true);
    setWorkspacesError(null);

    try {
      setWorkspaces(await listWorkspaces());
    } catch {
      setWorkspacesError('We could not load your workspaces.');
    } finally {
      setWorkspacesLoading(false);
    }
  }, []);

  const viewerRole = workspace?.viewerRole;

  const hasPermission = useCallback(
    (permission: WorkspacePermission) =>
      hasWorkspacePermission(viewerRole, permission),
    [viewerRole],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaceId,
      workspace,
      viewerRole,
      loading,
      error,
      reload,
      hasPermission,
      pageBreadcrumbs,
      setPageBreadcrumbs,
      workspaces,
      workspacesLoading,
      workspacesError,
      loadWorkspaces,
    }),
    [
      workspaceId,
      workspace,
      viewerRole,
      loading,
      error,
      reload,
      hasPermission,
      pageBreadcrumbs,
      workspaces,
      workspacesLoading,
      workspacesError,
      loadWorkspaces,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within WorkspaceProvider');
  }
  return context;
}
