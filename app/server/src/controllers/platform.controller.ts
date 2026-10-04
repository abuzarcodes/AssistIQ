import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import * as platformService from '../services/platform.service.js';
import * as platformSettingsService from '../services/platformSettings.service.js';
import type { UpdateSettingsInput } from '../schemas/platformSettings.schema.js';

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

/** The singleton settings row, created with its defaults if it is somehow absent. */
export const getSettings = asyncHandler(async (_req: Request, res: Response) => {
  const settings = await platformSettingsService.getSettings();
  sendSuccess(res, settings, 'Platform settings retrieved', 200);
});

/**
 * Partially update the settings.
 *
 * Only the supplied fields change, and the merged result is validated against the
 * cross-field invariants before anything is written — so a patch cannot leave the stored
 * configuration in a state where, say, the combined limit is below the per-file limit
 * (section 12.11). The service invalidates the settings cache after a successful write.
 */
export const updateSettings = asyncHandler(async (req: Request, res: Response) => {
  const settings = await platformSettingsService.updateSettings(
    req.body as UpdateSettingsInput
  );
  sendSuccess(res, settings, 'Platform settings updated', 200);
});
