import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
  addMemberSchema,
  memberParamsSchema,
  membersListParamsSchema,
  updateMemberRoleSchema,
} from '../schemas/workspaceMember.schema.js';
import * as workspaceMemberController from '../controllers/workspaceMember.controller.js';

/**
 * Member management, nested under /workspaces/:workspaceId/members (mergeParams exposes
 * :workspaceId). Mounted by workspace.routes.ts, behind `authenticate` and the workspace
 * permission middleware — reading the list needs `members:view`, every mutation needs
 * `members:manage` (OWNER only).
 */
export const workspaceMemberRouter = Router({ mergeParams: true });

workspaceMemberRouter.get(
  '/',
  validate({ params: membersListParamsSchema }),
  requireWorkspacePermission(PERMISSIONS.MEMBERS_VIEW),
  workspaceMemberController.listMembers
);

workspaceMemberRouter.post(
  '/',
  validate({ params: membersListParamsSchema, body: addMemberSchema }),
  requireWorkspacePermission(PERMISSIONS.MEMBERS_MANAGE),
  workspaceMemberController.addMember
);

workspaceMemberRouter.patch(
  '/:memberId',
  validate({ params: memberParamsSchema, body: updateMemberRoleSchema }),
  requireWorkspacePermission(PERMISSIONS.MEMBERS_MANAGE),
  workspaceMemberController.updateMemberRole
);

workspaceMemberRouter.delete(
  '/:memberId',
  validate({ params: memberParamsSchema }),
  requireWorkspacePermission(PERMISSIONS.MEMBERS_MANAGE),
  workspaceMemberController.removeMember
);
