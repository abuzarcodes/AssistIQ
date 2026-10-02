import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import * as workspaceService from '../services/workspace.service.js';
import type { CreateWorkspaceInput } from '../schemas/workspace.schema.js';

export const createWorkspace = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const workspace = await workspaceService.createWorkspace(userId, req.body as CreateWorkspaceInput);
  sendSuccess(res, workspace, 'Workspace created', 201);
});

export const listWorkspaces = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const workspaces = await workspaceService.listWorkspaces(userId);
  sendSuccess(res, workspaces, 'Workspaces retrieved', 200);
});

/**
 * Read a workspace, plus the caller's **own** role in it (`viewerRole`, Checkpoint 3).
 *
 * `viewerRole` is presentation-only — the client uses it to decide whether to render
 * management affordances. It is **never** an authorization decision: every route is still
 * gated by `requireWorkspacePermission`, and a client that lied about this field (it cannot
 * — it is computed here from the resolved membership, not from the request) would change
 * nothing about what the server permits. It is likewise never *accepted* as input; no
 * schema reads it from a body or query.
 */
export const getWorkspace = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const workspace = await workspaceService.getWorkspaceById(req.params.workspaceId, userId);
  const viewerRole = req.workspaceContext?.membership.role;
  sendSuccess(res, { ...workspace, viewerRole }, 'Workspace retrieved', 200);
});
