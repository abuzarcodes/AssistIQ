import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import * as workspaceMemberService from '../services/workspaceMember.service.js';
import type { AddMemberInput, UpdateMemberRoleInput } from '../schemas/workspaceMember.schema.js';

/**
 * Workspace member management.
 *
 * Authorization is applied by `requireWorkspacePermission` in the route table
 * (`members:view` / `members:manage`), so these handlers only orchestrate.
 * `:workspaceId` is available because the router is mounted with `mergeParams`.
 */

export const listMembers = asyncHandler(async (req: Request, res: Response) => {
  const members = await workspaceMemberService.listMembers(req.params.workspaceId);
  sendSuccess(res, members, 'Workspace members retrieved', 200);
});

export const addMember = asyncHandler(async (req: Request, res: Response) => {
  const { email, role } = req.body as AddMemberInput;
  const member = await workspaceMemberService.addMember(req.params.workspaceId, email, role);
  sendSuccess(res, member, 'Member added', 201);
});

export const updateMemberRole = asyncHandler(async (req: Request, res: Response) => {
  const { role } = req.body as UpdateMemberRoleInput;
  const member = await workspaceMemberService.updateMemberRole(
    req.params.workspaceId,
    req.params.memberId,
    role
  );
  sendSuccess(res, member, 'Member role updated', 200);
});

export const removeMember = asyncHandler(async (req: Request, res: Response) => {
  await workspaceMemberService.removeMember(req.params.workspaceId, req.params.memberId);
  sendSuccess(res, null, 'Member removed', 200);
});
