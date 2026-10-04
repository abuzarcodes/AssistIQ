import prisma from '../config/database.js';
import { AppError, ValidationError } from '../utils/errors.js';
import { assertConversationAccess } from './conversation.service.js';
import { resolveBotConfigForChat } from './botConfig.service.js';
import type { ContactField } from '../types/botConfig.types.js';
import type { ConversationContactInput } from '../schemas/botConfig.schema.js';

/**
 * Contact information collection (docs/BOT_IMPLEMENTATION_PLAN.md §10.7, §14.6).
 *
 * Per-conversation PII, deliberately **not** a Customer entity: AssistIQ has no end-user
 * identity system, and inventing one is out of scope. Values are never logged — only the
 * field *names* ever reach a log line — and the row cascades with its conversation.
 */

/**
 * Validate and upsert the contact details for a conversation.
 *
 * Scope is asserted through the conversation's bot membership (`assertConversationAccess`),
 * so a foreign conversation id is a 404 before any configuration is read. The order after
 * that is deliberate: config gate (409) → field membership (400) → required (400) → write,
 * so an owner who has not enabled collection gets an explicit "not enabled" rather than a
 * validation error about fields that do not apply.
 */
export const upsertContact = async (
  conversationId: string,
  userId: string,
  input: ConversationContactInput
) => {
  const conversation = await assertConversationAccess(conversationId, userId);
  const config = await resolveBotConfigForChat(conversation.botId);

  const collection = config.humanSupport.contactCollection;
  if (!collection || !collection.enabled) {
    throw new AppError('Contact collection is not enabled for this bot.', 409);
  }

  const supplied = (Object.keys(input) as Array<keyof ConversationContactInput>).filter(
    (key) => input[key] !== undefined && input[key] !== null && input[key] !== ''
  );

  const unknown = supplied.filter((key) => !collection.fields.includes(key as ContactField));
  if (unknown.length > 0) {
    throw new ValidationError(`These fields are not collected for this bot: ${unknown.join(', ')}`);
  }

  const missing = collection.required.filter((field) => !supplied.includes(field));
  if (missing.length > 0) {
    throw new ValidationError(`Missing required contact fields: ${missing.join(', ')}`);
  }

  const data = {
    name: input.name ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    orderId: input.orderId ?? null,
  };

  // `conversationId` is unique, so re-submitting updates rather than duplicating — the same
  // one-row-per-conversation guarantee feedback has per message (§22).
  return prisma.conversationContact.upsert({
    where: { conversationId },
    create: { conversationId, ...data },
    update: data,
  });
};