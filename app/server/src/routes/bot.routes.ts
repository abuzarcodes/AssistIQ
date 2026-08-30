import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { workspaceIdParamSchema } from '../schemas/workspace.schema.js';
import { createBotSchema, updateBotSchema, botIdParamSchema } from '../schemas/bot.schema.js';
import * as botController from '../controllers/bot.controller.js';
import { knowledgeCreateListRouter } from './knowledge.routes.js';
import { conversationCreateListRouter } from './conversation.routes.js';

/**
 * Nested under /workspaces/:workspaceId/bots (mergeParams exposes :workspaceId).
 * Mounted by workspace.routes.ts, which already sits behind authentication.
 */
export const botCreateListRouter = Router({ mergeParams: true });

botCreateListRouter.post(
  '/',
  validate({ params: workspaceIdParamSchema, body: createBotSchema }),
  botController.createBot
);
botCreateListRouter.get(
  '/',
  validate({ params: workspaceIdParamSchema }),
  botController.listBots
);

// Top-level /bots/:botId operations + nested knowledge/conversation resources.
const router = Router();

router.get('/:botId', validate({ params: botIdParamSchema }), botController.getBot);
router.patch(
  '/:botId',
  validate({ params: botIdParamSchema, body: updateBotSchema }),
  botController.updateBot
);
router.delete('/:botId', validate({ params: botIdParamSchema }), botController.deleteBot);

router.use('/:botId/knowledge', knowledgeCreateListRouter);
router.use('/:botId/conversations', conversationCreateListRouter);

export default router;
