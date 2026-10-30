import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { botIdParamSchema } from '../schemas/bot.schema.js';
import {
  botDeploymentParamSchema,
  updateDeploymentSchema,
  addDomainSchema,
  removeDomainParamSchema,
} from '../schemas/deployment.schema.js';
import * as deploymentController from '../controllers/deployment.controller.js';
import * as analyticsController from '../controllers/analytics.controller.js';
import { analyticsQuerySchema } from '../schemas/analytics.schema.js';

const router = Router({ mergeParams: true });
const botScope = { from: 'bot' } as const;

/**
 * GET /bots/:botId/deployments — List all deployments for a bot (CP-4.1)
 */
router.get(
  '/',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_VIEW, botScope),
  deploymentController.listDeployments
);

/**
 * PATCH /bots/:botId/deployments/:deploymentId — Update deployment settings (CP-4.2)
 */
router.patch(
  '/:deploymentId',
  validate({ params: botDeploymentParamSchema, body: updateDeploymentSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  deploymentController.updateDeployment
);

/**
 * GET /bots/:botId/deployments/:deploymentId/snippet — Get installation snippet (CP-4.3)
 */
router.get(
  '/:deploymentId/snippet',
  validate({ params: botDeploymentParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_VIEW, botScope),
  deploymentController.getDeploymentSnippet
);

/**
 * GET /bots/:botId/deployments/:deploymentId/analytics — Get deployment analytics (CP-5.5)
 */
router.get(
  '/:deploymentId/analytics',
  validate({ params: botDeploymentParamSchema, query: analyticsQuerySchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_VIEW, botScope),
  analyticsController.getDeploymentAnalytics
);

/**
 * GET /bots/:botId/deployments/:deploymentId/domains — List allowed domains (CP-4.7)
 */
router.get(
  '/:deploymentId/domains',
  validate({ params: botDeploymentParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_VIEW, botScope),
  deploymentController.listDomains
);

/**
 * POST /bots/:botId/deployments/:deploymentId/domains — Add allowed domain (CP-4.7)
 */
router.post(
  '/:deploymentId/domains',
  validate({ params: botDeploymentParamSchema, body: addDomainSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  deploymentController.addDomain
);

/**
 * DELETE /bots/:botId/deployments/:deploymentId/domains — Remove allowed domain (CP-4.7)
 */
router.delete(
  '/:deploymentId/domains',
  validate({ params: botDeploymentParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  deploymentController.removeDomain
);

/**
 * DELETE /bots/:botId/deployments/:deploymentId/domains/:domainId — Remove allowed domain by ID (CP-4.7)
 */
router.delete(
  '/:deploymentId/domains/:domainId',
  validate({ params: removeDomainParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  deploymentController.removeDomain
);

export const deploymentRouter = router;
export default router;
