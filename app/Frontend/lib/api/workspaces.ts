import { apiPost, apiGet } from '@/lib/api-client';

/** A caller's role within one workspace. Mirrors the server's `WorkspaceRole` enum. */
export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'AGENT';

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A workspace plus **the caller's own** role in it.
 *
 * `viewerRole` is what the detail endpoint adds on top of the plain workspace: the same
 * workspace returns a different value to each member, because it describes the *reader*,
 * not the workspace. It is `undefined` on the list endpoint, which does not resolve a
 * per-caller role — so treat a missing value as "unknown" and gate nothing on it.
 */
export interface WorkspaceDetail extends Workspace {
  viewerRole?: WorkspaceRole;
}

export function listWorkspaces() {
  return apiGet<Workspace[]>('/workspaces');
}

export function getWorkspace(workspaceId: string) {
  return apiGet<WorkspaceDetail>(`/workspaces/${workspaceId}`);
}

export function createWorkspace(name: string) {
  return apiPost<Workspace>('/workspaces', { name });
}
