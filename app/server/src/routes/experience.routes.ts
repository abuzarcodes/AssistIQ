import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { botIdParamSchema } from '../schemas/bot.schema.js';
import {
  updateExperienceSchema,
  publishExperienceSchema,
  versionIdParamSchema,
} from '../schemas/experience.schema.js';
import * as experienceController from '../controllers/experience.controller.js';

const botScope = { from: 'bot' } as const;

export const experienceRouter = Router({ mergeParams: true });

experienceRouter.get(
  '/',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_VIEW, botScope),
  experienceController.getExperience
);

experienceRouter.patch(
  '/',
  validate({ params: botIdParamSchema, body: updateExperienceSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  experienceController.updateExperience
);

experienceRouter.post(
  '/publish',
  validate({ params: botIdParamSchema, body: publishExperienceSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  experienceController.publishExperience
);

experienceRouter.post(
  '/unpublish',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  experienceController.unpublishExperience
);

experienceRouter.get(
  '/versions',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_VIEW, botScope),
  experienceController.listVersions
);

experienceRouter.get(
  '/versions/:versionId',
  validate({ params: versionIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_VIEW, botScope),
  experienceController.getVersion
);

experienceRouter.post(
  '/versions/:versionId/rollback',
  validate({ params: versionIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  experienceController.rollbackToVersion
);

export default experienceRouter;
