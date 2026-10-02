import type { Workspace } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import type { CreateWorkspaceInput } from '../schemas/workspace.schema.js';

/** Create a workspace owned by the given user. */
export const createWorkspace = (userId: string, input: CreateWorkspaceInput): Promise<Workspace> =>
  prisma.workspace.create({
    data: {
      name: input.name,
      // Both records are written, deliberately: `ownerId` is the legacy single-owner field
      // kept during the RBAC transition, and the `WorkspaceMember` row is the RBAC source of
      // truth. The nested write is one statement, so a workspace can never exist without an
      // OWNER membership.
      ownerId: userId,
      members: { create: { userId, role: 'OWNER' } },
    },
  });

/** List every workspace the user is a member of (any role). */
export const listWorkspaces = (userId: string): Promise<Workspace[]> =>
  prisma.workspace.findMany({
    where: { members: { some: { userId } } },
    orderBy: { createdAt: 'desc' },
  });

/**
 * Fetch a workspace the user is a member of, or throw 404.
 *
 * Membership (not `ownerId`) is the gate, so ADMIN and AGENT members are admitted. A caller
 * with no membership receives the same 404 as a caller asking for a non-existent workspace —
 * no cross-tenant existence leak (spec §7). Reused as the gate whenever a child resource is
 * created under a workspace.
 */
export const getWorkspaceById = async (workspaceId: string, userId: string): Promise<Workspace> => {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, members: { some: { userId } } },
  });

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  return workspace;
};
