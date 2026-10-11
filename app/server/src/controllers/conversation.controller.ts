import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { getAuthUser } from "../middleware/auth.middleware.js";
import { ForbiddenError } from "../utils/errors.js";
import * as conversationService from "../services/conversation.service.js";
import * as messageFeedbackService from "../services/messageFeedback.service.js";
import * as conversationContactService from "../services/conversationContact.service.js";
import type {
  AssignConversationInput,
  CreateMessageInput,
  MessageCursorQueryInput,
  QueueQueryInput,
} from "../schemas/conversation.schema.js";
import { messageCursorQuerySchema, queueQuerySchema } from "../schemas/conversation.schema.js";
import type {
  ConversationContactInput,
  MessageFeedbackInput,
} from "../schemas/botConfig.schema.js";

/**
 * The workspace context `requireWorkspacePermission` attaches. Typed as required here
 * because every route that reaches these handlers runs that middleware first — if it is
 * ever missing, the route table is wrong and failing loudly is the correct response.
 */
const getWorkspaceContext = (req: Request): NonNullable<Request['workspaceContext']> => {
  if (!req.workspaceContext) {
    throw new ForbiddenError('Workspace context is missing');
  }
  return req.workspaceContext;
};

export const createConversation = asyncHandler(
  async (req: Request, res: Response) => {
    const { id: userId } = getAuthUser(req);
    const conversation = await conversationService.createConversation(
      req.params.botId,
      userId,
    );
    sendSuccess(res, conversation, "Conversation created", 201);
  },
);

export const listConversations = asyncHandler(
  async (req: Request, res: Response) => {
    const { id: userId } = getAuthUser(req);
    const conversations = await conversationService.listConversationsByBot(
      req.params.botId,
      userId,
    );
    sendSuccess(res, conversations, "Conversations retrieved", 200);
  },
);

export const getConversation = asyncHandler(
  async (req: Request, res: Response) => {
    const { id: userId } = getAuthUser(req);
    const conversation = await conversationService.getConversationById(
      req.params.conversationId,
      userId,
    );
    sendSuccess(res, conversation, "Conversation retrieved", 200);
  },
);

/** POST /conversations/:conversationId/messages — the Review 1 chat flow (spec §14). */
export const sendMessage = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const { content } = req.body as CreateMessageInput;
  const result = await conversationService.addMessage(
    req.params.conversationId,
    userId,
    content,
  );
  sendSuccess(res, result, "Message processed", 201);
});

/**
 * POST /conversations/:conversationId/reply — a support agent's reply (§8.2, §14).
 *
 * Deliberately **not** `POST /messages`. That route predates escalation and is the dashboard's
 * "ask the bot" turn: its response carries `assistantMessage` and `ai`, and the client
 * (`app/client/lib/api/conversations.ts`, the bot's conversations page) and its tests depend
 * on that shape. An agent's reply produces no assistant message — the agent *is* the
 * assistant — so it is a different operation with a different result, and folding the two
 * into one route would mean a response whose shape depends on who called it.
 *
 * `messages` keeps its meaning (a human prompting the bot, now correctly suppressed outside
 * `ACTIVE`); `reply` is the new, narrower act of a human answering a customer.
 */
export const sendAgentReply = asyncHandler(async (req: Request, res: Response) => {
  const { id: agentId } = getAuthUser(req);
  const { workspaceId } = getWorkspaceContext(req);
  const { content } = req.body as CreateMessageInput;

  const message = await conversationService.addAgentMessage(
    req.params.conversationId,
    workspaceId,
    agentId,
    content,
  );

  sendSuccess(res, { message }, "Reply sent", 201);
});

/** POST /conversations/:conversationId/messages/:messageId/feedback (§10.6). */
export const upsertFeedback = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const feedback = await messageFeedbackService.upsertFeedback(
    req.params.conversationId,
    req.params.messageId,
    userId,
    req.body as MessageFeedbackInput,
  );
  sendSuccess(res, feedback, "Feedback recorded", 200);
});

/** DELETE /conversations/:conversationId/messages/:messageId/feedback (§10.6). */
export const deleteFeedback = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  await messageFeedbackService.deleteFeedback(
    req.params.conversationId,
    req.params.messageId,
    userId,
  );
  sendSuccess(res, null, "Feedback removed", 200);
});

/** POST /conversations/:conversationId/contact (§10.7). */
export const upsertContact = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const contact = await conversationContactService.upsertContact(
    req.params.conversationId,
    userId,
    req.body as ConversationContactInput,
  );
  sendSuccess(res, contact, "Contact details recorded", 200);
});

// ---------------------------------------------------------------------------------------
// Support queue and lifecycle control (HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md §14)
//
// Every handler below reads the workspace from `req.workspaceContext`, which
// `requireWorkspacePermission` has already populated with a workspace the caller is proven
// to belong to. The workspace is therefore never taken from the request body or from a
// parameter the caller controls — there is nothing to spoof.
// ---------------------------------------------------------------------------------------

/**
 * GET /workspaces/:workspaceId/conversations/queue?view=…
 *
 * The query schema is parsed a second time here, after `validate` has already checked it.
 * That is not redundant: Express's `req.query` accessor is a getter, so the middleware
 * validates in place and cannot write the coerced object back — the handler would still
 * see the string `'2'` for `limit` and `undefined` for an omitted `view`. Re-parsing with
 * the same schema is what applies the coercion and the default, and keeps the schema the
 * single source of truth for the bounds.
 */
export const listQueue = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const { workspaceId } = getWorkspaceContext(req);
  const { view, botId, limit } = queueQuerySchema.parse(req.query) as QueueQueryInput;

  const queue = await conversationService.listQueueConversations(workspaceId, userId, {
    view,
    ...(botId ? { botId } : {}),
    limit,
  });

  sendSuccess(res, queue, "Queue retrieved", 200);
});

/** POST /conversations/:conversationId/claim */
export const claimConversation = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const { workspaceId } = getWorkspaceContext(req);

  const conversation = await conversationService.claimConversation(
    req.params.conversationId,
    workspaceId,
    userId,
  );

  sendSuccess(res, conversation, "Conversation claimed", 200);
});

/** POST /conversations/:conversationId/assign */
export const assignConversation = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const { workspaceId } = getWorkspaceContext(req);
  const { agentId } = req.body as AssignConversationInput;

  const conversation = await conversationService.assignConversation(
    req.params.conversationId,
    workspaceId,
    userId,
    agentId,
  );

  sendSuccess(res, conversation, "Conversation assigned", 200);
});

/**
 * POST /conversations/:conversationId/unassign
 *
 * The caller's role is passed through rather than re-read: the service has to distinguish
 * handing back your own ticket from taking someone else's, and only the membership row
 * knows which the caller is. Re-reading it there would be a second chance to disagree with
 * the middleware.
 */
export const unassignConversation = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const { workspaceId, membership } = getWorkspaceContext(req);

  const conversation = await conversationService.unassignConversation(
    req.params.conversationId,
    workspaceId,
    userId,
    membership.role,
  );

  sendSuccess(res, conversation, "Conversation returned to the queue", 200);
});

/** POST /conversations/:conversationId/resolve */
export const resolveConversation = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const { workspaceId } = getWorkspaceContext(req);

  const conversation = await conversationService.resolveConversation(
    req.params.conversationId,
    workspaceId,
    userId,
  );

  sendSuccess(res, conversation, "Conversation resolved", 200);
});

/** POST /conversations/:conversationId/reopen */
export const reopenConversation = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const { workspaceId } = getWorkspaceContext(req);

  const conversation = await conversationService.reopenConversation(
    req.params.conversationId,
    workspaceId,
    userId,
  );

  sendSuccess(res, conversation, "Conversation reopened", 200);
});

/** GET /conversations/:conversationId/events */
export const listEvents = asyncHandler(async (req: Request, res: Response) => {
  const { workspaceId } = getWorkspaceContext(req);

  const events = await conversationService.listConversationEvents(
    req.params.conversationId,
    workspaceId,
  );

  sendSuccess(res, { items: events }, "Conversation events retrieved", 200);
});

/**
 * GET /conversations/:conversationId/messages?afterCreatedAt=…&afterId=… (§15.3.2)
 *
 * The recovery half of the realtime contract: an agent whose socket dropped backfills the
 * messages it missed by resuming from its newest `(createdAt, id)`. No cursor returns the
 * normal forward page, so the endpoint is also the plain transcript read.
 *
 * The query is re-parsed here for the same reason `listQueue` re-parses: `validate` checks
 * `req.query` in place and cannot write the coerced object back, so an omitted `limit` would
 * still be `undefined` and an omitted cursor would still be absent — the defaults and the
 * coercion only exist on the parsed result.
 */
export const listMessages = asyncHandler(async (req: Request, res: Response) => {
  const { workspaceId } = getWorkspaceContext(req);
  const { afterCreatedAt, afterId, limit } = messageCursorQuerySchema.parse(
    req.query,
  ) as MessageCursorQueryInput;

  const page = await conversationService.listConversationMessages(
    req.params.conversationId,
    workspaceId,
    {
      // The schema guarantees the two arrive together, so the cursor is either complete or
      // absent — never half-built.
      ...(afterCreatedAt !== undefined && afterId !== undefined
        ? { cursor: { afterCreatedAt: new Date(afterCreatedAt), afterId } }
        : {}),
      limit,
    },
  );

  sendSuccess(res, page, "Messages retrieved", 200);
});
