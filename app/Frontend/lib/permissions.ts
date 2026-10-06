import type { PlatformRole } from '@/lib/api/auth';
import type { WorkspaceRole } from '@/lib/api/workspaces';

/**
 * Client-side mirror of the server's permission model
 * (`app/server/src/constants/permissions.ts`).
 *
 * IMPORTANT: the server is the only authority. Everything here drives *presentation* —
 * which nav items and actions are offered — and must never be treated as enforcement.
 * A hidden button is a convenience, not a security boundary; the API rejects the call
 * regardless of what the UI shows.
 *
 * Both domains are mirrored, and they learn their role from different places:
 *
 * - **Platform** — the role arrives with every auth response, so it is always known.
 * - **Workspace** — the role is a property of one membership, so it comes from that
 *   workspace's own `viewerRole` field on the detail response. It is therefore `undefined`
 *   until that response has loaded, and on endpoints that do not resolve a per-caller role
 *   at all. An unknown role grants nothing here: the checks below return `false` for
 *   `undefined`, so a page that has not yet learned the role renders the conservative
 *   version rather than briefly offering actions the caller may not have. The server
 *   remains the only thing that actually decides.
 */

export const PLATFORM_PERMISSIONS = {
  AI_OPERATE: 'ai:operate',
  PLATFORM_ADMIN: 'platform:admin',
} as const;

export type PlatformPermission =
  (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS];

const PLATFORM_OWNER_PERMISSIONS: readonly PlatformPermission[] = [
  PLATFORM_PERMISSIONS.AI_OPERATE,
  PLATFORM_PERMISSIONS.PLATFORM_ADMIN,
];

/** Whether a platform role grants a platform-domain permission. */
export function hasPlatformPermission(
  role: PlatformRole | undefined,
  permission: PlatformPermission,
): boolean {
  if (role !== 'PLATFORM_OWNER') return false;
  return PLATFORM_OWNER_PERMISSIONS.includes(permission);
}

export const WORKSPACE_PERMISSIONS = {
  BOTS_MANAGE: 'bots:manage',
  KNOWLEDGE_MANAGE: 'knowledge:manage',
  DOCUMENTS_MANAGE: 'documents:manage',
} as const;

export type WorkspacePermission =
  (typeof WORKSPACE_PERMISSIONS)[keyof typeof WORKSPACE_PERMISSIONS];

/**
 * Mirrors the grants in `app/server/src/constants/permissions.ts` for the workspace
 * permissions a screen has to reason about.
 *
 * `knowledge:manage` and `documents:manage` are separate permissions server-side even
 * though the same two roles hold both today: FAQ entries and uploaded documents are
 * distinct resources with distinct lifecycles, and a screen asks about the one it is
 * acting on. Collapsing them here would make the client unable to express a difference the
 * server can already enforce.
 *
 * There is deliberately no `*:view` entry. Viewing is not offered conditionally anywhere —
 * a caller who cannot view is not on the page — so mirroring it would be a constant.
 */
const WORKSPACE_ROLE_PERMISSIONS: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  OWNER: [
    WORKSPACE_PERMISSIONS.BOTS_MANAGE,
    WORKSPACE_PERMISSIONS.KNOWLEDGE_MANAGE,
    WORKSPACE_PERMISSIONS.DOCUMENTS_MANAGE,
  ],
  ADMIN: [
    WORKSPACE_PERMISSIONS.BOTS_MANAGE,
    WORKSPACE_PERMISSIONS.KNOWLEDGE_MANAGE,
    WORKSPACE_PERMISSIONS.DOCUMENTS_MANAGE,
  ],
  AGENT: [],
};

/**
 * Whether a workspace role grants a workspace-domain permission.
 *
 * `undefined` — the role is not known yet, or the response did not carry one — grants
 * nothing. Defaulting the other way would show an AGENT a control that fails on use.
 */
export function hasWorkspacePermission(
  role: WorkspaceRole | undefined,
  permission: WorkspacePermission,
): boolean {
  if (role === undefined) return false;
  return WORKSPACE_ROLE_PERMISSIONS[role].includes(permission);
}
