import { z } from 'zod';

export const conversationIdParamSchema = z.object({
  conversationId: z.string().uuid('Invalid conversation id'),
});

export const createMessageSchema = z.object({
  content: z.string().trim().min(1, 'Message content is required').max(4000),
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;
