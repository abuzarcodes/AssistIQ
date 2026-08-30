import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { botIdParamSchema } from '../schemas/bot.schema.js';
import {
  createKnowledgeSchema,
  updateKnowledgeSchema,
  knowledgeIdParamSchema,
} from '../schemas/knowledge.schema.js';
import * as knowledgeController from '../controllers/knowledge.controller.js';

/**
 * Nested under /bots/:botId/knowledge (mergeParams exposes :botId). Mounted by
 * bot.routes.ts, which already sits behind authentication.
 */
export const knowledgeCreateListRouter = Router({ mergeParams: true });

knowledgeCreateListRouter.post(
  '/',
  validate({ params: botIdParamSchema, body: createKnowledgeSchema }),
  knowledgeController.createKnowledge
);
knowledgeCreateListRouter.get(
  '/',
  validate({ params: botIdParamSchema }),
  knowledgeController.listKnowledge
);
knowledgeCreateListRouter.delete(
  '/',
  validate({ params: botIdParamSchema }),
  knowledgeController.deleteAllKnowledge
);

// Top-level /knowledge/:knowledgeId operations.
const router = Router();

router.patch(
  '/:knowledgeId',
  validate({ params: knowledgeIdParamSchema, body: updateKnowledgeSchema }),
  knowledgeController.updateKnowledge
);
router.delete(
  '/:knowledgeId',
  validate({ params: knowledgeIdParamSchema }),
  knowledgeController.deleteKnowledge
);

export default router;
