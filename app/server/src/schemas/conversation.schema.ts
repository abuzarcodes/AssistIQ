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
