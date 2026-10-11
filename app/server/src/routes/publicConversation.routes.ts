import { createHash } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { validate } from '../middleware/validation.middleware.js';
import { authenticateVisitor } from '../middleware/visitorAuth.middleware.js';
import {
  conversationIdParamSchema,
  createVisitorMessageSchema,
  publicBotIdParamSchema,
  refreshVisitorSessionSchema,
  messageCursorQuerySchema,
} from '../schemas/conversation.schema.js';
import { conversationContactSchema } from '../schemas/botConfig.schema.js';
import * as publicConversationController from '../controllers/publicConversation.controller.js';

/**
 * The public conversation surface (`HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md` §10, §14).
 *
 * This is the **only** router in the API mounted without `authenticate`, and it is mounted
 * that way deliberately: a customer chatting from a merchant's site has no AssistIQ account
 * and never will. The shape follows the codebase's existing public-auth precedent —
 * `auth.routes.ts` is likewise mounted bare and guards its own endpoints — so the missing
 * global middleware is a decision at the mount point rather than an oversight that has to be
 * rediscovered route by route.
 *
 * Its credential is the scoped visitor token (§10.4), which names exactly one conversation
 * and one bot. Every route below that touches a conversation reaches it through
 * `authenticateVisitor`, so no handler here reads a conversation id from a body, and none is
 * reachable with a member token — `verifyVisitorToken` demands claims a member token never
 * carries, and `verifyToken` demands claims a visitor token never carries.
 */

/**
 * Starting a conversation is the one unauthenticated write, so it is limited by IP: there is
 * no credential yet to key on (§18.4).
 */
const startConversationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many conversations started. Please try again later.',
    message: 'Too many conversations started. Please try again later.',
  },
});

/**
 * Messaging is limited per *visitor token*, not per IP (§18.4).
 *
 * The distinction is the point. An IP limit would let one customer behind a shared corporate
 * NAT exhaust every other customer's budget on that network, while a single hostile client
 * with a pool of IPs would face no limit at all. The token is what is actually scarce here —
 * obtaining one costs a `POST /bots/:botId/conversations`, which is the IP-limited route.
 *
 * `keyGenerator` runs **after** `authenticateVisitor` on every route that uses it, so the
 * token it reads has already been verified. A forged token cannot mint itself a fresh bucket
 * because it never reaches this middleware.
 *
 * The key is the header's SHA-256 digest rather than the header itself: the limiter's store
 * holds keys for the length of the window, and a live credential has no business sitting in
 * it. The digest identifies the session just as well and is worthless if the store leaks.
 *
 * There is no IP branch. The digest of an absent header is a fixed key, which is both total
 * (this returns a string on every input, as the store requires) and the *most* restrictive
 * outcome if the middleware order ever changes — an unreachable path should fail closed.
 */
const visitorMessageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    createHash('sha256')
      .update(req.headers.authorization ?? '')
      .digest('hex'),
  message: {
    success: false,
    error: 'Too many messages. Please slow down.',
    message: 'Too many messages. Please slow down.',
  },
});

const router = Router();

// --- Session lifecycle -----------------------------------------------------------------

router.post(
  '/bots/:botId/conversations',
  startConversationLimiter,
  validate({ params: publicBotIdParamSchema }),
  publicConversationController.startConversation
);

/**
 * Renewal reads an *expired* token, which is the whole point of the endpoint — hence
 * `allowExpired` here and on no other route. The real credential is the session secret in
 * the body, which the service compares against the stored digest in constant time.
 */
router.post(
  '/conversations/:conversationId/refresh',
  validate({ params: conversationIdParamSchema, body: refreshVisitorSessionSchema }),
  authenticateVisitor({ allowExpired: true }),
  publicConversationController.refreshSession
);

// --- Transcript and messaging ----------------------------------------------------------

router.get(
  '/conversations/:conversationId',
  validate({ params: conversationIdParamSchema, query: messageCursorQuerySchema }),
  authenticateVisitor(),
  publicConversationController.getConversation
);

router.get(
  '/conversations/:conversationId/messages',
  validate({ params: conversationIdParamSchema, query: messageCursorQuerySchema }),
  authenticateVisitor(),
  publicConversationController.listMessages
);

router.post(
  '/conversations/:conversationId/messages',
  validate({ params: conversationIdParamSchema, body: createVisitorMessageSchema }),
  authenticateVisitor(),
  visitorMessageLimiter,
  publicConversationController.sendMessage
);

/**
 * Contact submission carries no limiter of its own. §18.4 specifies limits for conversation
 * creation and messaging only, and this endpoint is neither: it is an upsert of a fixed,
 * bot-configured field set onto a conversation the caller already holds a token for, so it
 * cannot grow storage and cannot be repeated into a larger effect than the first call.
 */
router.post(
  '/conversations/:conversationId/contact',
  validate({ params: conversationIdParamSchema, body: conversationContactSchema }),
  authenticateVisitor(),
  publicConversationController.submitContact
);

export default router;
