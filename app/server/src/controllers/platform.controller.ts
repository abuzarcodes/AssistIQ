import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import * as platformService from '../services/platform.service.js';

/**
 * Platform administration (Checkpoint 4).
 *
 * Every route here is mounted behind `authenticate` + `requirePlatformOwner()` in
 * routes/index.ts — handlers assume a verified PLATFORM_OWNER and contain no role logic.
 */

export const listUsers = asyncHandler(async (_req: Request, res: Response) => {
  const users = await platformService.listUsers();
  sendSuccess(res, users, 'Platform users retrieved', 200);
});

export const listWorkspaces = asyncHandler(async (_req: Request, res: Response) => {
  const workspaces = await platformService.listWorkspaces();
  sendSuccess(res, workspaces, 'Platform workspaces retrieved', 200);
});

export const getSystemStatus = asyncHandler(async (_req: Request, res: Response) => {
  const status = await platformService.getSystemStatus();
  sendSuccess(res, status, 'Platform system status retrieved', 200);
});
