import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import * as analyticsService from '../services/analytics.service.js';
import type { AnalyticsQueryInput, ClientEventInput } from '../schemas/analytics.schema.js';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';

/**
 * GET /bots/:botId/deployments/:deploymentId/analytics — Get metrics for a deployment (CP-5.5).
 */
export const getDeploymentAnalytics = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const data = await analyticsService.getDeploymentAnalytics(
    req.params.deploymentId,
    userId,
    req.query as AnalyticsQueryInput
  );
  sendSuccess(res, data, 'Deployment analytics retrieved', 200);
});

/**
 * GET /workspaces/:workspaceId/analytics/deployments — Get workspace analytics breakdown (CP-5.6).
 */
export const getWorkspaceAnalytics = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const data = await analyticsService.getWorkspaceAnalytics(
    req.params.workspaceId,
    userId,
    req.query as AnalyticsQueryInput
  );
  sendSuccess(res, data, 'Workspace analytics retrieved', 200);
});

/**
 * POST /public/deployments/:deploymentId/events — Client-reported analytics event (CP-5.4).
 */
export const recordClientEvent = asyncHandler(async (req: Request, res: Response) => {
  const { deploymentId } = req.params;
  const { eventType, sessionId, metadata } = req.body as ClientEventInput;

  const deployment = await prisma.botDeployment.findUnique({
    where: { id: deploymentId },
    select: { id: true, status: true, enabled: true },
  });

  if (!deployment || deployment.status !== 'PUBLISHED' || !deployment.enabled) {
    throw new NotFoundError('Deployment not found');
  }

  const event = await analyticsService.recordEvent(deploymentId, eventType, sessionId, metadata);

  sendSuccess(res, { recorded: Boolean(event) }, 'Event recorded', 201);
});
