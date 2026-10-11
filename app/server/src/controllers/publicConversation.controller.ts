import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getVisitorContext } from '../middleware/visitorAuth.middleware.js';
import * as conversationService from '../services/conversation.service.js';
import * as conversationContactService from '../services/conversationContact.service.js';
import {
  messageCursorQuerySchema,
  type CreateVisitorMessageInput,
  type MessageCursorQueryInput,
  type RefreshVisitorSessionInput,
} from '../schemas/conversation.schema.js';
import type { ConversationContactInput } from '../schemas/botConfig.schema.js';

/**
 * Translate the parsed cursor query into the service's `(createdAt, id)` position.
 *
 * Shared by the two transcript reads so the widget's recovery call behaves identically
 * whichever endpoint it resumes against (§15.3.4). The schema guarantees the two fields
 * arrive together, so the result is either a complete cursor or none at all.
 */
const toCursor = (query: MessageCursorQueryInput) =>
  query.afterCreatedAt !== undefined && query.afterId !== undefined
    ? { afterCreatedAt: new Date(query.afterCreatedAt), afterId: query.afterId }
    : undefined;

/**
 * The public visitor surface (`HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md` §10, §14).
 *
 * Every handler except `startConversation` runs behind `authenticateVisitor`, which has
 * already proven that the token names the conversation in the path *and* that the row still
 * matches the token's bot and workspace. The conversation id is therefore never taken from
 * the body, and no handler here re-derives the workspace — there is nothing to spoof and
 * nothing to re-check.
 *
 * Responses are deliberately narrower than their member-facing counterparts: no `senderId`,
 * no workspace id, no assignee. See `getVisitorTranscript` for why that projection is a
 * security boundary rather than a formatting choice.
 */

/** POST /public/bots/:botId/conversations — start a session (§10.3). */
export const startConversation = asyncHandler(async (req: Request, res: Response) => {
  const result = await conversationService.startPublicConversation(req.params.botId);

  // `sessionSecret` is present in this response and nowhere else, ever again.
  sendSuccess(
    res,
    {
      conversation: result.conversation,
      visitorToken: result.visitorToken,
      sessionSecret: result.sessionSecret,
    },
    'Conversation started',
    201
  );
});

/** GET /public/conversations/:conversationId — metadata plus the transcript tail (§14). */
export const getConversation = asyncHandler(async (req: Request, res: Response) => {
  const { conversationId } = getVisitorContext(req);

  // The transcript window is read from the query string even on this endpoint, so the
  // widget has one way to ask for messages rather than two subtly different ones.
  const query = messageCursorQuerySchema.parse(req.query) as MessageCursorQueryInput;

  const transcript = await conversationService.getVisitorTranscript(
    conversationId,
    query.limit,
    toCursor(query)
  );

  sendSuccess(res, transcript, 'Conversation retrieved', 200);
});

/** GET /public/conversations/:conversationId/messages — the transcript alone (§14). */
export const listMessages = asyncHandler(async (req: Request, res: Response) => {
  const { conversationId } = getVisitorContext(req);
  const query = messageCursorQuerySchema.parse(req.query) as MessageCursorQueryInput;

  const transcript = await conversationService.getVisitorTranscript(
    conversationId,
    query.limit,
    toCursor(query)
  );

  // The cursor is always present, `null` when the caller has caught up (§15.3.2, §15.3.4).
  // Present-and-null rather than omitted, so a client reads one field to decide whether to
  // poll again — and so the two transcript endpoints answer the question the same way.
  sendSuccess(
    res,
    {
      items: transcript.items,
      nextCursor: transcript.nextCursor
        ? {
            afterCreatedAt: transcript.nextCursor.afterCreatedAt.toISOString(),
            afterId: transcript.nextCursor.afterId,
          }
        : null,
    },
    'Messages retrieved',
    200
  );
});

/**
 * POST /public/conversations/:conversationId/messages — the customer's turn (§9.3).
 *
 * The turn reads the lifecycle state itself, after storing the message, so nothing about the
 * gate comes from this handler. In particular no version is carried in the visitor token: a
 * token lives 15 minutes and a conversation can move several times inside that window, so a
 * version baked into the credential would be stale by design and would fail Phase 3 for the
 * wrong reason.
 */
export const sendMessage = asyncHandler(async (req: Request, res: Response) => {
  const { conversationId, botId } = getVisitorContext(req);
  const { content, clientMessageId } = req.body as CreateVisitorMessageInput;

  const result = await conversationService.addCustomerMessage(
    conversationId,
    botId,
    content,
    clientMessageId
  );

  sendSuccess(
    res,
    {
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
      suppressed: result.suppressed,
      ...(result.suppressionReason ? { suppressionReason: result.suppressionReason } : {}),
      ...(result.escalation ? { escalation: result.escalation } : {}),
    },
    'Message processed',
    200
  );
});

/**
 * POST /public/conversations/:conversationId/refresh — renew the visitor token (§10.3).
 *
 * Reached with an expired token (the route runs `authenticateVisitor({ allowExpired: true })`)
 * and the long-lived session secret. Only the token is rotated; the secret is never reissued,
 * so a leaked response body does not extend an attacker's session beyond 15 minutes.
 */
export const refreshSession = asyncHandler(async (req: Request, res: Response) => {
  const { conversationId } = getVisitorContext(req);
  const { sessionSecret } = req.body as RefreshVisitorSessionInput;

  const result = await conversationService.refreshVisitorSession(conversationId, sessionSecret);

  sendSuccess(res, { visitorToken: result.visitorToken }, 'Session refreshed', 200);
});

/** POST /public/conversations/:conversationId/contact — submit contact details (§14). */
export const submitContact = asyncHandler(async (req: Request, res: Response) => {
  const { conversationId, botId } = getVisitorContext(req);

  const contact = await conversationContactService.upsertVisitorContact(
    conversationId,
    botId,
    req.body as ConversationContactInput
  );

  sendSuccess(res, contact, 'Contact details recorded', 200);
});
