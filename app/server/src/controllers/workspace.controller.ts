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

export const getWorkspace = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const workspace = await workspaceService.getWorkspaceById(req.params.workspaceId, userId);
  sendSuccess(res, workspace, 'Workspace retrieved', 200);
});
