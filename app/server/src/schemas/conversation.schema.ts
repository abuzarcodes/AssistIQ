import { z } from 'zod';

export const conversationIdParamSchema = z.object({
  conversationId: z.string().uuid('Invalid conversation id'),
});

export const createMessageSchema = z.object({
  content: z.string().trim().min(1, 'Message content is required').max(4000),
});

/**
 * Params for the per-message feedback routes (§10.6).
 *
 * Both ids are uuids validated before any handler runs, so a malformed id is a 400 and never
 * reaches a query. The message id is additionally scoped to the conversation in the service,
 * so a foreign message id is a 404 rather than a cross-tenant write.
 */
export const messageFeedbackParamSchema = z.object({
  conversationId: z.string().uuid('Invalid conversation id'),
  messageId: z.string().uuid('Invalid message id'),
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;

// ---------------------------------------------------------------------------------------
// Support queue and lifecycle control (HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md §14)
// ---------------------------------------------------------------------------------------

/** The four queue tabs the support inbox offers (§16.1). */
export const QUEUE_VIEWS = ['unassigned', 'assigned', 'all_active', 'resolved'] as const;

/**
 * Queue query. `view` defaults to the unassigned queue because that is the tab an agent
 * lands on, and a default keeps the endpoint usable without a query string.
 *
 * `limit` is coerced from the string the query string always delivers, and is capped so a
 * caller cannot ask for the whole table.
 */
export const queueQuerySchema = z.object({
  view: z.enum(QUEUE_VIEWS).default('unassigned'),
  botId: z.string().uuid('Invalid bot id').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Assignment target. Only the target is accepted — the conversation comes from the path and
 * the workspace from the resolved scope, so neither can be influenced by the body.
 */
export const assignConversationSchema = z.object({
  agentId: z.string().uuid('Invalid agent id'),
});

/** The workspace a queue listing is scoped to. */
export const queueParamSchema = z.object({
  workspaceId: z.string().uuid('Invalid workspace id'),
});

export type QueueQueryInput = z.infer<typeof queueQuerySchema>;
export type AssignConversationInput = z.infer<typeof assignConversationSchema>;
export type QueueView = (typeof QUEUE_VIEWS)[number];

// =======================================================================================
// Public visitor surface (§10, §14)
//
// These are the only schemas in the file that validate input from an unauthenticated
// caller, which is why they carry explicit ceilings on every string: nothing here is
// bounded by a prior authorization step.
// =======================================================================================

/** How many messages a transcript request returns by default, and at most. */
export const TRANSCRIPT_DEFAULT_LIMIT = 50;
export const TRANSCRIPT_MAX_LIMIT = 200;

/**
 * The bot a public conversation is started under.
 *
 * Named distinctly from `bot.schema.ts`'s `botIdParamSchema`: that one is the *member* route
 * parameter, resolved through a bot → workspace membership chain. This one is reached by an
 * unauthenticated caller and carries no such chain, so the two must not be interchangeable
 * at an import site.
 */
export const publicBotIdParamSchema = z.object({
  botId: z.string().uuid('Invalid bot id'),
});

/**
 * Session renewal (§10.3).
 *
 * The secret is validated only for *shape* — 64 hex characters, matching the 32 bytes the
 * server generates — so an obviously malformed value is a 400 without a database read. A
 * well-formed but wrong secret is a 401 from the service, which is where the constant-time
 * comparison against the stored digest lives.
 *
 * Not trimmed and not lowercased: the secret is compared by digest, so any normalisation
 * here would have to be mirrored exactly on the signing side, and a mismatch would present
 * as a wrong-secret 401 rather than as the formatting bug it actually is.
 */
export const refreshVisitorSessionSchema = z.object({
  sessionSecret: z.string().regex(/^[0-9a-f]{64}$/, 'Invalid session secret'),
});

/**
 * A customer's message (§14).
 *
 * `clientMessageId` is accepted but optional: the widget sends it so a retry after a lost
 * response is recognisable, and the column exists for that reason (§13.1). It is bounded
 * and length-checked to the column's `VarChar(64)` so a value the database would reject is
 * a 400 here instead of a 500 at the driver.
 */
export const createVisitorMessageSchema = z.object({
  content: z.string().trim().min(1, 'Message content is required').max(4000),
  clientMessageId: z.string().trim().min(1).max(64).optional(),
});

/**
 * Transcript window, with the optional reconnection cursor (§15.3.2).
 *
 * `limit` is bounded here as a *string* contract because `validate` checks query in place —
 * the coercion that actually applies the default happens in the controller, which re-parses
 * with this same schema (see `knowledgeChunk.controller.ts` for the idiom).
 *
 * Shared by both transcripts: the customer's (`GET /public/conversations/:id/messages`) and
 * the member's (`GET /conversations/:id/messages`). One schema because §15.3.4's recovery
 * procedure is not audience-specific — the same client-side rule ("call with my newest
 * `(createdAt, id)` and render what comes back") has to hold on both surfaces, and two
 * schemas would be two chances for the cursor semantics to diverge.
 *
 * The two cursor fields are required **together**. `afterCreatedAt` alone reads as
 * "everything since this instant", which silently loosens the comparison from `>` to `>=`
 * and re-delivers the boundary message; `afterId` alone names no position at all. Rejecting a
 * half-cursor is better than guessing which of the two behaviours the caller meant.
 *
 * A cursor rather than a bare timestamp because messages do not have unique timestamps: a bot
 * reply and the escalation that follows it can be written inside the same millisecond, and
 * `createdAt > x` would then drop one of them permanently.
 */
export const messageCursorQuerySchema = z
  .object({
    afterCreatedAt: z
      .string()
      .datetime({ offset: true, message: 'afterCreatedAt must be an ISO-8601 timestamp' })
      .optional(),
    afterId: z.string().uuid('Invalid cursor id').optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(TRANSCRIPT_MAX_LIMIT)
      .default(TRANSCRIPT_DEFAULT_LIMIT),
  })
  .refine((value) => (value.afterCreatedAt === undefined) === (value.afterId === undefined), {
    message: 'afterCreatedAt and afterId must be provided together',
    path: ['afterId'],
  });

export type PublicBotIdParamInput = z.infer<typeof publicBotIdParamSchema>;
export type RefreshVisitorSessionInput = z.infer<typeof refreshVisitorSessionSchema>;
export type CreateVisitorMessageInput = z.infer<typeof createVisitorMessageSchema>;
export type MessageCursorQueryInput = z.infer<typeof messageCursorQuerySchema>;
