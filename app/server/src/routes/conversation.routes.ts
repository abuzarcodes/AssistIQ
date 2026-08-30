import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { botIdParamSchema } from '../schemas/bot.schema.js';
import {
  conversationIdParamSchema,
  createMessageSchema,
} from '../schemas/conversation.schema.js';
import * as conversationController from '../controllers/conversation.controller.js';

/**
 * Nested under /bots/:botId/conversations (mergeParams exposes :botId). Mounted by
 * bot.routes.ts, which already sits behind authentication.
 */
export const conversationCreateListRouter = Router({ mergeParams: true });

conversationCreateListRouter.post(
  '/',
  validate({ params: botIdParamSchema }),
  conversationController.createConversation
);
conversationCreateListRouter.get(
  '/',
  validate({ params: botIdParamSchema }),
  conversationController.listConversations
);

// Top-level /conversations/:conversationId operations, including the chat flow.
const router = Router();

router.get(
  '/:conversationId',
  validate({ params: conversationIdParamSchema }),
  conversationController.getConversation
);
router.post(
  '/:conversationId/messages',
  validate({ params: conversationIdParamSchema, body: createMessageSchema }),
  conversationController.sendMessage
);

export default router;
