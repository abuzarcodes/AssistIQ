import prisma from '../config/database.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { assertConversationAccess } from './conversation.service.js';
import { resolveBotConfigForChat } from './botConfig.service.js';
import type { MessageFeedbackInput } from '../schemas/botConfig.schema.js';

/**
 * Per-assistant-message feedback (docs/BOT_IMPLEMENTATION_PLAN.md §10.6).
 *
 * One row per message by construction (`messageId @unique` + `upsert`), so re-rating
 * updates rather than duplicates (§22). Every read and write is scoped through the
 * conversation's bot membership, and a message id from another conversation is
 * indistinguishable from a missing one (404), never a cross-tenant leak (§21).
 */

/**
 * The shared gates: the conversation is visible to the caller, the message belongs to it and
 * is an ASSISTANT message, and the bot has feedback enabled.
 *
 * `feedbackEnabled = false` is a **409**, not a silent no-op: the endpoint exists, the caller
 * is permitted, and the reason it did nothing is a configuration state they can change —
 * saying so explicitly is the difference between a bug report and a settings page.
 */
const assertRateable = async (conversationId: string, messageId: string, userId: string) => {
  const conversation = await assertConversationAccess(conversationId, userId);

  const message = await prisma.message.findFirst({
    where: { id: messageId, conversationId },
    select: { id: true, role: true },
  });
  if (!message) {
    // Scoped by `conversationId`, so a message in another tenant's conversation is the same
    // answer as a message that does not exist.
    throw new NotFoundError('Message not found');
  }
  if (message.role !== 'ASSISTANT') {
    throw new ValidationError('Feedback can only be given on an assistant message.');
  }

  const config = await resolveBotConfigForChat(conversation.botId);
  if (!config.conversation.feedbackEnabled) {
    throw new AppError('Feedback is not enabled for this bot.', 409);
  }

  return conversation;
};

/** Create or replace the caller's rating for one assistant message. */
export const upsertFeedback = async (
  conversationId: string,
  messageId: string,
  userId: string,
  input: MessageFeedbackInput
) => {
  await assertRateable(conversationId, messageId, userId);

  const data = {
    rating: input.rating,
    reason: input.reason ?? null,
    comment: input.comment ?? null,
  };

  return prisma.messageFeedback.upsert({
    where: { messageId },
    create: { messageId, conversationId, ...data },
    update: data,
  });
};

/** Remove a rating (undo a mis-click). A missing row is a 404, not a silent success. */
export const deleteFeedback = async (
  conversationId: string,
  messageId: string,
  userId: string
): Promise<void> => {
  await assertRateable(conversationId, messageId, userId);

  const existing = await prisma.messageFeedback.findUnique({ where: { messageId } });
  if (!existing) {
    throw new NotFoundError('Feedback not found');
  }

  await prisma.messageFeedback.delete({ where: { messageId } });
};