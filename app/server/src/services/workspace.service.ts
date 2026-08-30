import type { Workspace } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import type { CreateWorkspaceInput } from '../schemas/workspace.schema.js';

/** Create a workspace owned by the given user. */
export const createWorkspace = (ownerId: string, input: CreateWorkspaceInput): Promise<Workspace> =>
  prisma.workspace.create({ data: { name: input.name, ownerId } });

/** List all workspaces owned by the given user. */
export const listWorkspaces = (ownerId: string): Promise<Workspace[]> =>
  prisma.workspace.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
  });

/**
 * Fetch a workspace the user owns, or throw 404.
 *
 * The `ownerId` is part of the query, so another user's workspace is indistinguishable
 * from a non-existent one — no cross-tenant existence leak (spec §7). Reused as the
 * ownership gate whenever a child resource is created under a workspace.
 */
export const getWorkspaceById = async (workspaceId: string, ownerId: string): Promise<Workspace> => {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, ownerId },
  });

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  return workspace;
};
