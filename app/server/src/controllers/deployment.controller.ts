import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import * as deploymentService from '../services/deployment.service.js';
import type { AddDomainInput, UpdateDeploymentInput } from '../schemas/deployment.schema.js';
import { ValidationError } from '../utils/errors.js';

/**
 * GET /bots/:botId/deployments — List all deployments for a bot (CP-4.1).
 */
export const listDeployments = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const deployments = await deploymentService.listDeployments(req.params.botId, userId);
  sendSuccess(res, deployments, 'Deployments retrieved', 200);
});

/**
 * PATCH /bots/:botId/deployments/:deploymentId — Update deployment settings (CP-4.2).
 */
export const updateDeployment = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const updated = await deploymentService.updateDeployment(
    req.params.deploymentId,
    userId,
    req.body as UpdateDeploymentInput
  );
  sendSuccess(res, updated, 'Deployment updated', 200);
});

/**
 * GET /bots/:botId/deployments/:deploymentId/snippet — Get installation snippet (CP-4.3).
 */
export const getDeploymentSnippet = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const snippet = await deploymentService.getDeploymentSnippet(req.params.deploymentId, userId);
  sendSuccess(res, snippet, 'Deployment snippet retrieved', 200);
});

/**
 * GET /bots/:botId/deployments/:deploymentId/domains — List allowed domains for a deployment (CP-4.7).
 */
export const listDomains = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const domains = await deploymentService.listDomains(req.params.deploymentId, userId);
  sendSuccess(res, domains, 'Allowed domains retrieved', 200);
});

/**
 * POST /bots/:botId/deployments/:deploymentId/domains — Add domain to allowlist (CP-4.7).
 */
export const addDomain = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const { domain } = req.body as AddDomainInput;
  const created = await deploymentService.addDomain(req.params.deploymentId, domain, userId);
  sendSuccess(res, created, 'Allowed domain added', 201);
});

/**
 * DELETE /bots/:botId/deployments/:deploymentId/domains(/:domainId)? — Remove domain from allowlist (CP-4.7).
 */
export const removeDomain = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const domainOrId =
    req.params.domainId ||
    (req.query.domain as string) ||
    (req.body?.domain as string) ||
    (req.body?.domainId as string);

  if (!domainOrId) {
    throw new ValidationError('Domain or domainId is required to remove.');
  }

  const result = await deploymentService.removeDomain(req.params.deploymentId, domainOrId, userId);
  sendSuccess(res, result, 'Allowed domain removed', 200);
});
