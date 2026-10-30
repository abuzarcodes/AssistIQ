import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import * as experienceService from '../services/experience.service.js';
import type { UpdateExperienceInput, PublishExperienceInput } from '../schemas/experience.schema.js';

/**
 * GET /bots/:botId/experience
 * Retrieve or initialize the draft experience configuration.
 */
export const getExperience = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const experience = await experienceService.getExperience(req.params.botId!, userId);
  sendSuccess(res, experience, 'Experience configuration retrieved', 200);
});

/**
 * PATCH /bots/:botId/experience
 * Partially update the draft experience configuration.
 */
export const updateExperience = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const experience = await experienceService.updateExperience(
    req.params.botId!,
    userId,
    req.body as UpdateExperienceInput
  );
  sendSuccess(res, experience, 'Experience configuration updated', 200);
});

/**
 * POST /bots/:botId/experience/publish
 * Publish draft configuration, create immutable version snapshot and deploy.
 */
export const publishExperience = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const experience = await experienceService.publishExperience(
    req.params.botId!,
    userId,
    req.body as PublishExperienceInput
  );
  sendSuccess(res, experience, 'Experience published successfully', 200);
});

/**
 * POST /bots/:botId/experience/unpublish
 * Unpublish experience, revoking public access and updating epoch.
 */
export const unpublishExperience = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const experience = await experienceService.unpublishExperience(req.params.botId!, userId);
  sendSuccess(res, experience, 'Experience unpublished successfully', 200);
});

/**
 * GET /bots/:botId/experience/versions
 * List all historical published versions.
 */
export const listVersions = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const versions = await experienceService.listVersions(req.params.botId!, userId);
  sendSuccess(res, versions, 'Experience versions retrieved', 200);
});

/**
 * GET /bots/:botId/experience/versions/:versionId
 * Get configuration snapshot for a specific version.
 */
export const getVersion = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const version = await experienceService.getVersion(
    req.params.botId!,
    req.params.versionId!,
    userId
  );
  sendSuccess(res, version, 'Experience version retrieved', 200);
});

/**
 * POST /bots/:botId/experience/versions/:versionId/rollback
 * Restore draft configuration from a previous version without auto-publishing.
 */
export const rollbackToVersion = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const experience = await experienceService.rollbackToVersion(
    req.params.botId!,
    req.params.versionId!,
    userId
  );
  sendSuccess(res, experience, 'Experience rolled back to version successfully', 200);
});
