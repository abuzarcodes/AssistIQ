import type { Conversation, Message } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { getBotById } from './bot.service.js';
import { aiServiceClient, type ChatResponse } from './aiServiceClient.js';
import { resolveBotModel } from './botModelResolver.js';
import { MODEL_UNAVAILABLE_MESSAGE } from '../constants/aiFailure.js';
import { logger } from '../config/logger.js';
import { MessageRole } from '../constants/roles.js';

/** Create a conversation under a bot in a workspace the caller belongs to. */
export const createConversation = async (
  botId: string,
  userId: string
): Promise<Conversation> => {
  await getBotById(botId, userId);
  return prisma.conversation.create({ data: { botId } });
};

/** List a bot's conversations (after asserting access to the bot). */
export const listConversationsByBot = async (
  botId: string,
  userId: string
): Promise<Conversation[]> => {
  await getBotById(botId, userId);
  return prisma.conversation.findMany({
    where: { botId },
    orderBy: { createdAt: 'desc' },
  });
};

export type ConversationWithMessages = Conversation & { messages: Message[] };

/** Fetch a conversation in a workspace the caller belongs to, with messages in order. */
export const getConversationById = async (
  conversationId: string,
  userId: string
): Promise<ConversationWithMessages> => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, bot: { workspace: { members: { some: { userId } } } } },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  return conversation;
};

/** Lightweight scope gate that also yields the conversation's botId. */
const getOwnedConversation = async (
  conversationId: string,
  userId: string
): Promise<{ id: string; botId: string }> => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, bot: { workspace: { members: { some: { userId } } } } },
    select: { id: true, botId: true },
  });

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  return conversation;
};

export interface SendMessageResult {
  userMessage: Message;
  assistantMessage: Message;
  ai: ChatResponse;
}

/**
 * The Review 1 chat flow (spec §14):
 *   1-2. Validate the conversation exists and the caller belongs to its workspace.
 *   3.   Store the USER message.
 *   4.   Resolve the bot's model, then gather knowledge and call the AI service boundary.
 *   5.   Store the ASSISTANT message.
 *   6.   Return both messages plus AI metadata.
 *
 * The AI service is reached only through `generateResponse`; this service never talks
 * to Python directly and controllers never talk to the AI service at all.
 */
export const addMessage = async (
  conversationId: string,
  userId: string,
  content: string
): Promise<SendMessageResult> => {
  const conversation = await getOwnedConversation(conversationId, userId);

  const userMessage = await prisma.message.create({
    data: { conversationId, role: MessageRole.USER, content },
  });

  const ai = await generateResponse(conversation.botId, content);

  if (ai.fallback_required) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { status: 'WAITING_FOR_HUMAN' },
    });
  }

  const assistantMessage = await prisma.message.create({
    data: { conversationId, role: MessageRole.ASSISTANT, content: ai.response },
  });

  return { userMessage, assistantMessage, ai };
};

/**
 * Resolve the bot's model, then either call the AI service or short-circuit (Checkpoint 6).
 *
 * The short-circuit returns a `ChatResponse`-shaped object rather than throwing, so the
 * escalation and persistence logic in `addMessage` needs no second branch: an unusable
 * model and a conversational dead end reach the customer through the same path, and both
 * flip the conversation to `WAITING_FOR_HUMAN`.
 *
 * Validation happens **before** the AI call, so a model the platform owner has switched off
 * consumes no provider spend — and `aiServiceClient.chat` is not reached at all, which is
 * asserted rather than assumed in the tests.
 */
const generateResponse = async (botId: string, content: string): Promise<ChatResponse> => {
  const resolution = await resolveBotModel(botId);

  if (!resolution.ok) {
    // The `detail` names the broken row and is for operators only; the customer sees the
    // fixed message below. Logged at `error` because every cause of this branch is a
    // configuration fault demanding action, not a transient blip.
    logger.error(
      { botId, reason: resolution.reason, detail: resolution.detail },
      'Bot model unavailable — skipping the AI call and escalating'
    );

    return {
      status: 'fallback',
      response: MODEL_UNAVAILABLE_MESSAGE,
      fallback_required: true,
      reason: resolution.reason,
    };
  }

  return aiServiceClient.chat({
    bot_id: botId,
    message: content,
    // Spread rather than `model: resolution.model`: a bot with no assignment must send the
    // payload it sent before this checkpoint, with no `model` key at all.
    ...(resolution.model ? { model: resolution.model } : {}),
  });
};

