import type { Conversation, Message, Prisma } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { getBotById } from './bot.service.js';
import { aiServiceClient, type ChatResponse } from './aiServiceClient.js';
import { resolveBotModel } from './botModelResolver.js';
import { resolveBotConfigForChat, toPythonConfig } from './botConfig.service.js';
import { decideEscalation } from './escalationPolicy.js';
import { resolveSourceLabels } from './sourceLabels.js';
import { BOT_PAUSED_MESSAGE, MODEL_UNAVAILABLE_MESSAGE } from '../constants/aiFailure.js';
import { logger } from '../config/logger.js';
import { MessageRole } from '../constants/roles.js';
import type { EscalationInfo, ResolvedBotConfig, SourceRef } from '../types/botConfig.types.js';

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

/**
 * The conversation read, extended in Checkpoint 5 to carry the data a human agent needs:
 * per-message feedback and the collected contact details (§10.4).
 *
 * `contact` is included here but deliberately **not** on the list endpoint: the inbox stays
 * light, and PII is only fetched for the conversation a member has opened (§10.7).
 */
export type ConversationWithMessages = Conversation & {
  messages: (Message & {
    feedback: { rating: string; reason: string | null; comment: string | null } | null;
  })[];
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    orderId: string | null;
  } | null;
};

/** Fetch a conversation in a workspace the caller belongs to, with messages in order. */
export const getConversationById = async (
  conversationId: string,
  userId: string
): Promise<ConversationWithMessages> => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, bot: { workspace: { members: { some: { userId } } } } },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        include: { feedback: { select: { rating: true, reason: true, comment: true } } },
      },
      contact: true,
    },
  });

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  return conversation as unknown as ConversationWithMessages;
};

/**
 * Lightweight scope gate that also yields the conversation's botId.
 *
 * Exported (Checkpoint 5) so the feedback and contact services reuse the *one* membership
 * query rather than each writing their own — a second copy is a second thing that can be
 * scoped slightly wrong.
 */
export const assertConversationAccess = async (
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
  /** Present only when the bot shows sources and at least one was retrieved (§10.5). */
  sources?: SourceRef[];
  /** Present when the turn escalated, or produced an acceptance line (§10.5). */
  escalation?: EscalationInfo;
}

/**
 * The Review 1 chat flow (spec §14), extended by Checkpoint 5:
 *   1-2. Validate the conversation exists and the caller belongs to its workspace.
 *   3.   Store the USER message.
 *   4.   Resolve the bot's configuration and models, then call the AI service boundary.
 *   5.   Apply the human-support policy (fallback copy, escalation, acceptance copy).
 *   6.   Store the ASSISTANT message (with sources when enabled).
 *   7.   Return both messages plus AI metadata and escalation state.
 *
 * The AI service is reached only through `generateResponse`; this service never talks to
 * Python directly and controllers never talk to the AI service at all.
 */
export const addMessage = async (
  conversationId: string,
  userId: string,
  content: string
): Promise<SendMessageResult> => {
  const conversation = await assertConversationAccess(conversationId, userId);

  // One config read for the whole turn. The same value decides the payload Python receives,
  // the fallback copy, the escalation policy and whether sources are persisted — so those
  // cannot disagree with each other within a single message (§22).
  const config = await resolveBotConfigForChat(conversation.botId);

  const userMessage = await prisma.message.create({
    data: { conversationId, role: MessageRole.USER, content },
  });

  const ai = await generateResponse(conversation.botId, content, config);

  const decision = decideEscalation(config, ai, new Date());

  if (decision.escalate) {
    // A single update: the status transition and the escalation metadata are written
    // together, so a reader never sees a `WAITING_FOR_HUMAN` row with no reason (§22).
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: new Date(),
        escalationReason: decision.reason,
        escalatedOffHours: decision.offHours,
      },
    });
  }

  const sources = config.knowledge.showSources
    ? await resolveSourceLabels(ai.sources, conversation.botId)
    : null;

  const assistantMessage = await prisma.message.create({
    data: {
      conversationId,
      role: MessageRole.ASSISTANT,
      content: decision.response,
      // Persisted only when sources are enabled *and* something was cited. The default path
      // writes no new data, which is what keeps existing bots' rows unchanged (§15.3).
      ...(sources && sources.length > 0
        ? { sources: sources as unknown as Prisma.InputJsonValue }
        : {}),
    },
  });

  const result: SendMessageResult = {
    userMessage,
    assistantMessage,
    // The customer-facing answer reflects the policy decision; `ai` still carries the raw
    // reason, retrieval metadata and the Node-only model fields.
    ai: { ...ai, response: decision.response },
  };

  if (sources && sources.length > 0) {
    result.sources = sources;
  }

  if (decision.escalate || decision.acceptanceMessage) {
    result.escalation = {
      required: decision.escalate,
      offHours: decision.offHours,
      ...(decision.acceptanceMessage
        ? { acceptanceMessage: decision.acceptanceMessage }
        : {}),
    };
  }

  return result;
};

/**
 * Resolve the bot's configuration and models, then either call the AI service or short-circuit.
 *
 * Two short-circuits run **before** any AI call, and both are deliberate:
 *   - **Paused** (`isActive = false`) — a product state, not a fault. It returns a normal
 *     answer with `fallback_required: false`, so the conversation stays `ACTIVE` and no human
 *     is woken for a bot the owner switched off (§5.1, §6).
 *   - **Model unavailable** — a configuration fault. It returns a reason-coded fallback with
 *     `fallback_required: true`, so the customer escalates exactly as for a conversational
 *     dead end, and `aiServiceClient.chat` is never reached (asserted, not assumed).
 *
 * Both `model` and `fallback_model` come from `resolveBotModel`, which reads the bot row —
 * never request input — which is the structural reason a client cannot name a model.
 */
const generateResponse = async (
  botId: string,
  content: string,
  config: ResolvedBotConfig
): Promise<ChatResponse> => {
  if (!config.general.isActive) {
    logger.info({ botId }, 'Bot is paused — skipping the AI call');
    return {
      status: 'fallback',
      response: BOT_PAUSED_MESSAGE,
      fallback_required: false,
    };
  }

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

  // The primary is unusable and the fallback is serving. Logged at WARNING rather than
  // `error` because the customer is still being served — but loudly enough that an operator
  // notices a primary they believe is live is not (§13.2).
  if (resolution.promoted) {
    logger.warn(
      { botId, provider: resolution.model?.provider, modelId: resolution.model?.model_id },
      'Primary model is unusable — the fallback model is serving this bot'
    );
  }

  return aiServiceClient.chat({
    bot_id: botId,
    message: content,
    // Spread rather than `model: resolution.model`: a bot with no assignment must send the
    // payload it sent before this checkpoint, with no `model` key at all.
    ...(resolution.model ? { model: resolution.model } : {}),
    // The failover descriptor is sent only when it can actually serve, so Python never
    // spends a timeout retrying a model Node already knows is unusable (§13.2 rung 3).
    ...(resolution.fallbackModel ? { fallback_model: resolution.fallbackModel } : {}),
    // The resolved configuration, projected to the narrow shape the pipeline understands.
    config: toPythonConfig(config),
  });
};