import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { botIdParamSchema } from '../schemas/bot.schema.js';
import {
  assignConversationSchema,
  conversationIdParamSchema,
  createMessageSchema,
  messageCursorQuerySchema,
  messageFeedbackParamSchema,
  queueQuerySchema,
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

/**
 * The workspace-wide support queue, mounted at
 * `/workspaces/:workspaceId/conversations/queue` by workspace.routes.ts.
 *
 * Cross-bot on purpose: an agent works a queue, not a bot, so this is the one conversation
 * listing that is not scoped to a single bot. The workspace id is in the path and resolved
 * by the default `params` scope.
 */
export const workspaceConversationRouter = Router({ mergeParams: true });

workspaceConversationRouter.get(
  '/queue',
  validate({ query: queueQuerySchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_VIEW),
  conversationController.listQueue
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
// A human answering a customer, as distinct from a human prompting the bot (see
// `sendAgentReply`). Same permission: both are "reply in this conversation".
router.post(
  '/:conversationId/reply',
  validate({ params: conversationIdParamSchema, body: createMessageSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_REPLY, conversationScope),
  conversationController.sendAgentReply
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

// ---------------------------------------------------------------------------------------
// Lifecycle control (HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md §8.2, §14).
//
// Each transition is gated on the permission that matches the *act*, not on a single
// blanket "can touch conversations" gate:
//   claim    — conversations:claim   (OWNER, ADMIN, AGENT)  take work from the queue
//   assign   — conversations:assign  (OWNER, ADMIN)         put work on another person
//   unassign — conversations:claim   (OWNER, ADMIN, AGENT)  then narrowed in the service:
//                                     moving someone *else's* ticket also needs assign
//   resolve  — conversations:resolve (OWNER, ADMIN, AGENT)
//   reopen   — conversations:resolve (OWNER, ADMIN, AGENT)
//
// The 404-vs-403 boundary is the middleware's: a non-member gets 404 from the conversation
// scope, a member whose role lacks the permission gets 403.
// ---------------------------------------------------------------------------------------

router.post(
  '/:conversationId/claim',
  validate({ params: conversationIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_CLAIM, conversationScope),
  conversationController.claimConversation
);
router.post(
  '/:conversationId/assign',
  validate({ params: conversationIdParamSchema, body: assignConversationSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_ASSIGN, conversationScope),
  conversationController.assignConversation
);
// Gated on `claim` because an AGENT must be able to hand back their own ticket; the
// service then requires `assign` for anyone unassigning a conversation that is not theirs.
router.post(
  '/:conversationId/unassign',
  validate({ params: conversationIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_CLAIM, conversationScope),
  conversationController.unassignConversation
);
router.post(
  '/:conversationId/resolve',
  validate({ params: conversationIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_RESOLVE, conversationScope),
  conversationController.resolveConversation
);
router.post(
  '/:conversationId/reopen',
  validate({ params: conversationIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_RESOLVE, conversationScope),
  conversationController.reopenConversation
);

/** The durable audit trail behind a conversation (§13.1). */
router.get(
  '/:conversationId/events',
  validate({ params: conversationIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_VIEW, conversationScope),
  conversationController.listEvents
);

/**
 * Message recovery cursor (§15.3.2, §15.3.4).
 *
 * `conversations:view` and not `conversations:reply`: this is a read of a transcript the
 * caller may already see, and gating the *recovery* path more tightly than the transcript it
 * recovers would mean an agent whose socket dropped cannot catch up on a conversation they
 * are allowed to read. It shares a path with the POST above and differs by method, which is
 * the same split the rest of this router uses.
 */
router.get(
  '/:conversationId/messages',
  validate({ params: conversationIdParamSchema, query: messageCursorQuerySchema }),
  requireWorkspacePermission(PERMISSIONS.CONVERSATIONS_VIEW, conversationScope),
  conversationController.listMessages
);

export default router;