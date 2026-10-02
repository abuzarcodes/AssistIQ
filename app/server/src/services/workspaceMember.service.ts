import type { WorkspaceMember, WorkspaceRole } from '@prisma/client';
import prisma from '../config/database.js';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * Workspace membership CRUD (Checkpoint 4).
 *
 * Invariants enforced here (not in the controller, so they hold for every caller):
 *   - A user appears at most once per workspace (`@@unique([userId, workspaceId])`).
 *   - The workspace's `ownerId` membership can never be re-roled or removed. While
 *     `Workspace.ownerId` is still authoritative, silently rewriting it would desync the
 *     legacy and RBAC models — ownership transfer is a deliberate future feature.
 */

/** Member rows always come back with a safe, password-free user projection. */
const memberInclude = {
  user: {
    select: { id: true, name: true, email: true, platformRole: true },
  },
} as const;

export type MemberWithUser = WorkspaceMember & {
  user: { id: string; name: string; email: string; platformRole: string };
};

/** List a workspace's members, oldest first (the OWNER is normally first). */
export const listMembers = (workspaceId: string): Promise<MemberWithUser[]> =>
  prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: memberInclude,
    orderBy: { createdAt: 'asc' },
  });

/** Fetch a member by id, scoped to the workspace, or throw 404. */
const getMemberOr404 = async (workspaceId: string, memberId: string): Promise<WorkspaceMember> => {
  const member = await prisma.workspaceMember.findFirst({
    where: { id: memberId, workspaceId },
  });

  if (!member) {
    throw new NotFoundError('Workspace member not found');
  }

  return member;
};

/**
 * Reject mutations of the workspace owner's own membership. Returns the owner's user id
 * so callers do not have to re-read the workspace.
 */
const assertNotWorkspaceOwner = async (workspaceId: string, member: WorkspaceMember): Promise<void> => {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true },
  });

  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  if (workspace.ownerId === member.userId) {
    throw new ValidationError(
      'The workspace owner’s membership cannot be changed or removed. Transfer ownership first.'
    );
  }
};

/** Add an existing user to the workspace by email. */
export const addMember = async (
  workspaceId: string,
  email: string,
  role: WorkspaceRole
): Promise<MemberWithUser> => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Distinct from a workspace 404: the caller is a member, so revealing that no such
    // *user account* exists does not leak tenant information.
    throw new NotFoundError('No user with that email exists');
  }

  const existing = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
  });
  if (existing) {
    throw new ConflictError('That user is already a member of this workspace');
  }

  return prisma.workspaceMember.create({
    data: { workspaceId, userId: user.id, role },
    include: memberInclude,
  });
};

/** Change a member's role. The workspace owner's membership is immutable. */
export const updateMemberRole = async (
  workspaceId: string,
  memberId: string,
  role: WorkspaceRole
): Promise<MemberWithUser> => {
  const member = await getMemberOr404(workspaceId, memberId);
  await assertNotWorkspaceOwner(workspaceId, member);

  return prisma.workspaceMember.update({
    where: { id: memberId },
    data: { role },
    include: memberInclude,
  });
};

/** Remove a member from the workspace. The workspace owner cannot be removed. */
export const removeMember = async (workspaceId: string, memberId: string): Promise<void> => {
  const member = await getMemberOr404(workspaceId, memberId);
  await assertNotWorkspaceOwner(workspaceId, member);

  await prisma.workspaceMember.delete({ where: { id: memberId } });
};
