import type { Conversation, Message } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { getBotById } from './bot.service.js';
import { aiServiceClient, type ChatResponse } from './aiServiceClient.js';
import { MessageRole } from '../constants/roles.js';

/** Create a conversation under a bot the caller owns. */
export const createConversation = async (
  botId: string,
  ownerId: string
): Promise<Conversation> => {
  await getBotById(botId, ownerId);
  return prisma.conversation.create({ data: { botId } });
};

/** List a bot's conversations (after asserting ownership of the bot). */
export const listConversationsByBot = async (
  botId: string,
  ownerId: string
): Promise<Conversation[]> => {
  await getBotById(botId, ownerId);
  return prisma.conversation.findMany({
    where: { botId },
    orderBy: { createdAt: 'desc' },
  });
};

export type ConversationWithMessages = Conversation & { messages: Message[] };

/** Fetch a conversation the caller owns, including its messages in chronological order. */
export const getConversationById = async (
  conversationId: string,
  ownerId: string
): Promise<ConversationWithMessages> => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, bot: { workspace: { ownerId } } },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  return conversation;
};

/** Lightweight ownership gate that also yields the conversation's botId. */
const getOwnedConversation = async (
  conversationId: string,
  ownerId: string
): Promise<{ id: string; botId: string }> => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, bot: { workspace: { ownerId } } },
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
 *   1-2. Validate the conversation exists and belongs to the caller.
 *   3.   Store the USER message.
 *   4.   Gather the bot's knowledge and call the AI service boundary.
 *   5.   Store the ASSISTANT message.
 *   6.   Return both messages plus AI metadata.
 *
 * The AI service is reached only through `generateResponse`; this service never talks
 * to Python directly and controllers never talk to the AI service at all.
 */
export const addMessage = async (
  conversationId: string,
  ownerId: string,
  content: string
): Promise<SendMessageResult> => {
  const conversation = await getOwnedConversation(conversationId, ownerId);

  const userMessage = await prisma.message.create({
    data: { conversationId, role: MessageRole.USER, content },
  });

  const ai = await aiServiceClient.chat({
    bot_id: conversation.botId,
    message: content,
  });

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

