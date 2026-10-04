import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { botIdParamSchema } from '../schemas/bot.schema.js';
import {
  conversationIdParamSchema,
  createMessageSchema,
  messageFeedbackParamSchema,
} from '../schemas/conversation.schema.js';
import {
  messageFeedbackSchema,
  conversationContactSchema,
} from '../schemas/botConfig.schema.js';
import * as conversationController from '../controllers/conversation.controller.js';

const botScope = { from: 'bot' } as const;
const conversationScope = { from: 'conversation' } as const;

/**
 * Nested under /bots/:botId/conversations (mergeParams exposes :botId). Mounted by
 * bot.routes.ts, which already sits behind authentication.
 */
export const conversationCreateListRouter = Router({ mergeParams: true });

conversationCreateListRouter.post(
  '/',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_VIEW, botScope),
  conversationController.createConversation
);
conversationCreateListRouter.get(
  '/',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_VIEW, botScope),
  conversationController.listConversations
);

// Top-level /conversations/:conversationId operations, including the chat flow. The
// workspace is resolved through the conversation. Posting a message requires
// `conversations:reply` — granted to OWNER, ADMIN and AGENT (Checkpoint 7).
const router = Router();

router.get(
  '/:conversationId',
  validate({ params: conversationIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_VIEW, conversationScope),
  conversationController.getConversation
);
router.post(
  '/:conversationId/messages',
  validate({ params: conversationIdParamSchema, body: createMessageSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_REPLY, conversationScope),
  conversationController.sendMessage
);

// ---------------------------------------------------------------------------------------
// Feedback and contact (§10.6, §10.7). Both are conversational actions — an agent replying
// to a customer can rate an answer or record the details the customer gave — so they reuse
// `conversations:reply` rather than introducing a permission. An AGENT holds it; a non-member
// still gets 404 through the conversation scope.
// ---------------------------------------------------------------------------------------

router.post(
  '/:conversationId/messages/:messageId/feedback',
  validate({ params: messageFeedbackParamSchema, body: messageFeedbackSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_REPLY, conversationScope),
  conversationController.upsertFeedback
);
router.delete(
  '/:conversationId/messages/:messageId/feedback',
  validate({ params: messageFeedbackParamSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_REPLY, conversationScope),
  conversationController.deleteFeedback
);
router.post(
  '/:conversationId/contact',
  validate({ params: conversationIdParamSchema, body: conversationContactSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_REPLY, conversationScope),
  conversationController.upsertContact
);

export default router;