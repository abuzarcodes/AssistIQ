import type { WorkspaceMember } from '@prisma/client';
import prisma from '../config/database.js';
import { hasPermission, PLATFORM_OWNER_PERMISSIONS, type Permission } from '../constants/permissions.js';

/**
 * Authorization data access (Checkpoint 3).
 *
 * This module answers the two RBAC questions:
 *   - Platform:  "is this user a PLATFORM_OWNER?"       → `isPlatformOwner`
 *   - Workspace: "what is this user's role here?"       → `getWorkspaceMembership`
 *
 * It performs no HTTP concerns (no throwing on denial) — the middleware decides whether a
 * denial is a 403 or a 404. Keeping the queries here means the middleware stays thin and
 * the checks are mockable in tests.
 */

/** The caller's membership in a workspace, or null when they are not a member. */
export const getWorkspaceMembership = (
  userId: string,
  workspaceId: string
): Promise<WorkspaceMember | null> =>
  prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });

/**
 * Whether the user holds the global PLATFORM_OWNER role.
 *
 * Always read from the database rather than the JWT: a role change takes effect on the
 * very next request instead of waiting up to `JWT_EXPIRES_IN` for the token to cycle.
 */
export const isPlatformOwner = async (userId: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  });

  return user?.platformRole === 'PLATFORM_OWNER';
};

/** Whether the user may perform `permission` on the platform (AI Lab, platform admin). */
export const hasPlatformPermission = async (
  userId: string,
  permission: Permission
): Promise<boolean> => {
  if (!PLATFORM_OWNER_PERMISSIONS.has(permission)) {
    return false;
  }
  return isPlatformOwner(userId);
};

/**
 * DB-aware workspace permission check: resolves the membership first, then evaluates the
 * role's grants. Returns false when the user is not a member — callers translate that into
 * a 404, never a 403, so tenant existence is not leaked.
 */
export const hasWorkspacePermission = async (
  userId: string,
  workspaceId: string,
  permission: Permission
): Promise<boolean> => {
  const membership = await getWorkspaceMembership(userId, workspaceId);
  if (!membership) {
    return false;
  }

  return hasPermission(membership.role, permission);
};
