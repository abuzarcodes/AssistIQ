import type { WorkspaceRole } from '@prisma/client';

/**
 * RBAC permission catalogue (single source of truth).
 *
 * Naming convention: `<resource>:<action>`. These strings are the contract used by
 * `requireWorkspacePermission(...)` in routes and by `hasPermission(...)` in the
 * authorization service — never inline a literal permission string in a route.
 */
export const PERMISSIONS = {
  WORKSPACE_VIEW: 'workspace:view',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_DELETE: 'workspace:delete',

  MEMBERS_VIEW: 'members:view',
  MEMBERS_MANAGE: 'members:manage',

  BOTS_VIEW: 'bots:view',
  BOTS_MANAGE: 'bots:manage',

  KNOWLEDGE_VIEW: 'knowledge:view',
  KNOWLEDGE_MANAGE: 'knowledge:manage',

  DOCUMENTS_VIEW: 'documents:view',
  DOCUMENTS_MANAGE: 'documents:manage',

  CONVERSATIONS_VIEW: 'conversations:view',
  CONVERSATIONS_REPLY: 'conversations:reply',
  CONVERSATIONS_ASSIGN: 'conversations:assign',
  CONVERSATIONS_RESOLVE: 'conversations:resolve',
  CONVERSATIONS_MANAGE: 'conversations:manage',

  AI_USE: 'ai:use',
  AI_OPERATE: 'ai:operate',

  PLATFORM_ADMIN: 'platform:admin',

  BILLING_VIEW: 'billing:view',
  BILLING_MANAGE: 'billing:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Workspace-role → permission grants, exactly mirroring the RBAC role-permission matrix
 * in the plan.
 *
 * `documents:*` currently mirror `knowledge:*` (documents are a knowledge sub-resource)
 * and are defined separately for future extensibility. `billing:*` are FUTURE features
 * granted to OWNER only — ADMIN's `billing:view` is deliberately not granted yet.
 */
export const WORKSPACE_ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<Permission>> = {
  OWNER: new Set<Permission>([
    PERMISSIONS.WORKSPACE_VIEW,
    PERMISSIONS.WORKSPACE_UPDATE,
    PERMISSIONS.WORKSPACE_DELETE,
    PERMISSIONS.MEMBERS_VIEW,
    PERMISSIONS.MEMBERS_MANAGE,
    PERMISSIONS.BOTS_VIEW,
    PERMISSIONS.BOTS_MANAGE,
    PERMISSIONS.KNOWLEDGE_VIEW,
    PERMISSIONS.KNOWLEDGE_MANAGE,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.DOCUMENTS_MANAGE,
    PERMISSIONS.CONVERSATIONS_VIEW,
    PERMISSIONS.CONVERSATIONS_REPLY,
    PERMISSIONS.CONVERSATIONS_ASSIGN,
    PERMISSIONS.CONVERSATIONS_RESOLVE,
    PERMISSIONS.CONVERSATIONS_MANAGE,
    PERMISSIONS.AI_USE,
    PERMISSIONS.BILLING_VIEW,
    PERMISSIONS.BILLING_MANAGE,
  ]),

  // Operational administrator. Cannot manage members or delete/rename the workspace.
  ADMIN: new Set<Permission>([
    PERMISSIONS.WORKSPACE_VIEW,
    PERMISSIONS.MEMBERS_VIEW,
    PERMISSIONS.BOTS_VIEW,
    PERMISSIONS.BOTS_MANAGE,
    PERMISSIONS.KNOWLEDGE_VIEW,
    PERMISSIONS.KNOWLEDGE_MANAGE,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.DOCUMENTS_MANAGE,
    PERMISSIONS.CONVERSATIONS_VIEW,
    PERMISSIONS.CONVERSATIONS_REPLY,
    PERMISSIONS.CONVERSATIONS_ASSIGN,
    PERMISSIONS.CONVERSATIONS_RESOLVE,
    PERMISSIONS.CONVERSATIONS_MANAGE,
    PERMISSIONS.AI_USE,
  ]),

  // Customer support. Read-only context + reply/resolve; cannot assign or manage.
  AGENT: new Set<Permission>([
    PERMISSIONS.WORKSPACE_VIEW,
    PERMISSIONS.KNOWLEDGE_VIEW,
    PERMISSIONS.DOCUMENTS_VIEW,
    PERMISSIONS.CONVERSATIONS_VIEW,
    PERMISSIONS.CONVERSATIONS_REPLY,
    PERMISSIONS.CONVERSATIONS_RESOLVE,
    PERMISSIONS.AI_USE,
  ]),
};

/**
 * Platform-domain permissions. These are granted by the global `PLATFORM_OWNER` role and
 * are intentionally NOT part of `WORKSPACE_ROLE_PERMISSIONS` — platform authorization and
 * workspace authorization are evaluated independently (a PLATFORM_OWNER who is only an
 * AGENT in a workspace stays an AGENT there).
 */
export const PLATFORM_OWNER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  PERMISSIONS.AI_OPERATE,
  PERMISSIONS.PLATFORM_ADMIN,
]);

/**
 * Pure role→permission evaluation. No database access — see
 * `authorization.service.ts` for the DB-aware helpers.
 */
export const hasPermission = (role: WorkspaceRole, permission: Permission): boolean =>
  WORKSPACE_ROLE_PERMISSIONS[role].has(permission);
