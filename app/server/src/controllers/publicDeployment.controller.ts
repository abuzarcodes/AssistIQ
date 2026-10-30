import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { NotFoundError } from '../utils/errors.js';
import * as deploymentService from '../services/deployment.service.js';
import { recordEvent } from '../services/analytics.service.js';

/**
 * GET /public/deployments/:deploymentId/config (CP-3.2, CP-5.8)
 * Serve published experience configuration for a specific deployment.
 * Rate limited to 60/min per IP.
 */
export const getDeploymentConfig = asyncHandler(async (req: Request, res: Response) => {
  const { deploymentId } = req.params;
  const payload = await deploymentService.getPublishedConfig(deploymentId!);

  if (!payload) {
    throw new NotFoundError('Deployment not found or not published');
  }

  const sessionId = (req.query.sessionId as string) || (req.headers['x-session-id'] as string);
  if (sessionId) {
    void recordEvent(payload.deployment.id, 'page_view', sessionId).catch(() => {});
  }

  sendSuccess(res, payload, 'Published deployment configuration retrieved', 200);
});

/**
 * GET /public/deployments/slug/:slug/config (CP-3.3, CP-5.8)
 * Resolve hosted public chat page slug to published deployment configuration.
 */
export const getDeploymentConfigBySlug = asyncHandler(async (req: Request, res: Response) => {
  const { slug } = req.params;
  const payload = await deploymentService.getPublishedConfigBySlug(slug!);

  if (!payload) {
    throw new NotFoundError('Deployment not found or not published');
  }

  const sessionId = (req.query.sessionId as string) || (req.headers['x-session-id'] as string);
  if (sessionId) {
    void recordEvent(payload.deployment.id, 'page_view', sessionId).catch(() => {});
  }

  sendSuccess(res, payload, 'Published deployment configuration retrieved', 200);
});
