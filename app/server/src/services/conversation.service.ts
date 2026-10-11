import type { Conversation, Message, Prisma } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import prisma from '../config/database.js';
import {
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../utils/errors.js';
import { signVisitorToken } from '../utils/jwt.js';
import { getBotById } from './bot.service.js';
import { aiServiceClient, type ChatResponse } from './aiServiceClient.js';
import { resolveBotModel } from './botModelResolver.js';
import { resolveBotConfigForChat, toPythonConfig } from './botConfig.service.js';
import { decideEscalation } from './escalationPolicy.js';
import { resolveSourceLabels } from './sourceLabels.js';
import { BOT_PAUSED_MESSAGE, MODEL_UNAVAILABLE_MESSAGE } from '../constants/aiFailure.js';
import { logger } from '../config/logger.js';
import { ConversationEventType, ConversationStatus, MessageRole } from '../constants/roles.js';
import { PERMISSIONS, hasPermission } from '../constants/permissions.js';
import { emitConversationEvent, emitMessageCreated, emitQueueUpdated } from '../realtime/events.js';
import type { WorkspaceRole } from '@prisma/client';
import type { EscalationInfo, ResolvedBotConfig, SourceRef } from '../types/botConfig.types.js';

/** Create a conversation under a bot in a workspace the caller belongs to. */
export const createConversation = async (
  botId: string,
  userId: string
): Promise<Conversation> => {
  const bot = await getBotById(botId, userId);
  // `workspaceId` is denormalised from the bot at creation: it is the column every queue
  // query and tenant check filters on, and the two are written together so they cannot
  // drift. `getBotById` has already proven the caller is a member of that workspace.
  return prisma.conversation.create({ data: { botId, workspaceId: bot.workspaceId } });
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
  /**
   * The bot's reply, or **`null`** when the turn was suppressed.
   *
   * Null is a first-class outcome, not an error (§9.2): the customer's message is always
   * persisted, and the assistant half is simply not written when a human owns the
   * conversation, when the turn was cancelled, or when the answer arrived too late to be
   * true any more. A caller that treats `null` as a failure has misread the contract.
   */
  assistantMessage: Message | null;
  /** The raw AI metadata, or `null` whenever no AI call was made or its answer was dropped. */
  ai: ChatResponse | null;
  /** Whether the assistant half of this turn was suppressed. */
  suppressed: boolean;
  /** Why it was suppressed. Absent when `suppressed` is false. */
  suppressionReason?: TurnSuppressionReason;
  /** Present only when the bot shows sources and at least one was retrieved (§10.5). */
  sources?: SourceRef[];
  /** Present when the turn escalated, or produced an acceptance line (§10.5). */
  escalation?: EscalationInfo;
}

/**
 * Why the assistant half of a turn produced no message.
 *
 * The three are kept distinct because they mean different things operationally:
 *   - `AI_BYPASSED` — expected and permanent. A human owns this conversation, so the bot
 *     was never asked. This is the normal path for every customer message in the queue.
 *   - `ABORTED` — the turn was cancelled in flight (Phase 2). Normal under concurrency.
 *   - `STALE` — the AI answered, but the conversation had moved on by the time the answer
 *     was ready (Phase 3). The authoritative backstop, and the one that catches a
 *     cancellation that arrived too late or landed on another instance.
 */
export type TurnSuppressionReason = 'AI_BYPASSED' | 'ABORTED' | 'STALE';

/** The facts a chat turn needs, already authorized by one of the two entry points below. */
interface TurnInput {
  conversationId: string;
  botId: string;
  content: string;
  /**
   * The customer's own id for this message, echoed back over realtime (§15.3.3).
   *
   * The visitor surface is the only caller that supplies it. A customer who sends a message
   * and then loses their connection has no server round-trip to correlate against, so they
   * render the message locally under this id and reconcile it with the `message:new` event —
   * or with the recovery fetch — by identity rather than by guessing at content and time.
   */
  clientMessageId?: string;
}

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/**
 * Every message moves the conversation's `updatedAt` (§8.2).
 *
 * Deliberately **not** a version bump: `version` exists to invalidate an in-flight AI turn,
 * and a customer's own message must not invalidate the very turn it is starting. This write
 * is also what the `assigned` queue view sorts by, so an agent's list rises on the message
 * that needs them.
 */
const touchConversation = async (conversationId: string): Promise<void> => {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });
};

// ---------------------------------------------------------------------------------------
// Phase 2: the in-flight turn registry (§9.2)
// ---------------------------------------------------------------------------------------

/**
 * One `AbortController` per conversation with a live AI call.
 *
 * In-memory and therefore per-instance, which is a known and accepted limit: it is an
 * optimisation that saves an LLM call, not a correctness mechanism. Phase 3 is the
 * correctness mechanism, and it works regardless of which instance the cancellation landed
 * on. The map is keyed by conversation rather than by request because a conversation may
 * only usefully have one answer in flight.
 */
const activeAITurns = new Map<string, AbortController>();

/** Cancel an in-flight AI turn for a conversation, if one exists (§9.2). */
const abortActiveAITurn = (conversationId: string): void => {
  const controller = activeAITurns.get(conversationId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
};

/**
 * Register a new turn, superseding any turn already running for this conversation.
 *
 * Superseding matters as much as aborting: without it, a second message would leave the
 * first controller unreachable in the map — so a later claim would abort the *newer* turn
 * and let the older one run to completion and attempt a write. Aborting here means the
 * older answer is discarded as `ABORTED` at the source rather than being relied on to fail
 * the Phase 3 check.
 */
const startAITurn = (conversationId: string): AbortController => {
  abortActiveAITurn(conversationId);
  const controller = new AbortController();
  activeAITurns.set(conversationId, controller);
  return controller;
};

/** Release a turn's slot, but only if it is still ours — a newer turn may have replaced us. */
const endAITurn = (conversationId: string, controller: AbortController): void => {
  if (activeAITurns.get(conversationId) === controller) {
    activeAITurns.delete(conversationId);
  }
};

/**
 * The two lifecycle facts a turn is gated on: whether the AI may answer, and which version
 * it is answering against.
 *
 * Read by conversation id alone, without a workspace scope — and that is a deliberate choice
 * rather than an omission. Both entry points have *already* proven access by the time this
 * runs: a member through the membership query in `assertConversationAccess`, a visitor
 * through `authenticateVisitor`'s re-read of the row. This read is the gate, not the
 * authorization, and adding a second scope check here would not make the turn safer — it
 * would only make "who is allowed here" have two answers.
 *
 * It is read *inside* the turn, after the customer's message is stored, so it describes the
 * state at the moment generation would begin. A caller-supplied status would be a snapshot
 * from before the request's own write, which is the one moment the turn is most likely to be
 * wrong about.
 */
const readTurnState = async (
  conversationId: string
): Promise<{ status: ConversationStatus; version: number; workspaceId: string }> => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    // `workspaceId` rides along because every realtime emission this turn makes has to name
    // the queue room (§15.2) — and this read is the only one the turn is already making.
    select: { status: true, version: true, workspaceId: true },
  });

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  return conversation;
};

/**
 * Whether a conversation in this state is listed by any queue view (§16.1).
 *
 * Drives the `queue:updated` nudge: an `ACTIVE` conversation held by the AI appears in no
 * queue, so a message on it moves nothing an agent is looking at and a refetch would be
 * pure noise. The two other live states are both listed, and a message on either one changes
 * where the ticket sits in the agent's list.
 */
const isQueueVisible = (status: ConversationStatus): boolean =>
  status === ConversationStatus.WAITING_FOR_HUMAN || status === ConversationStatus.HUMAN_ACTIVE;

/**
 * The Review 1 chat flow (spec §14), rebuilt in CP3 on the three-phase concurrency design
 * of §9.2. Called by a workspace member; the customer-facing entry point is
 * `addCustomerMessage`, which shares this engine.
 *
 * The ordering below is the entire point of the checkpoint:
 *
 *   **Phase 1 (pre-flight gate).** The state is read after the message is stored and before
 *   anything is generated. Outside `ACTIVE` the AI is never called — not
 *   called-and-discarded, *never called* — which is what keeps a human-owned conversation
 *   from costing tokens and what makes Invariant #4 true at the start of the turn rather
 *   than only at the end.
 *
 *   **Phase 2 (in-flight cancellation).** The AI call runs under an `AbortController`, so a
 *   transition away from `ACTIVE` cuts the HTTP request off.
 *
 *   **Phase 3 (optimistic conditional commit).** The answer is committed only if the
 *   conversation is *still* `ACTIVE` at the same `version` it was when the turn began. This
 *   is the authoritative check: it holds across instances, and it is what actually
 *   guarantees no stale bot reply is ever persisted.
 */
const runTurn = async (input: TurnInput): Promise<SendMessageResult> => {
  // One config read for the whole turn. The same value decides the payload Python receives,
  // the fallback copy, the escalation policy and whether sources are persisted — so those
  // cannot disagree with each other within a single message (§22).
  const config = await resolveBotConfigForChat(input.botId);

  // The customer's words are stored first and unconditionally: whatever happens to the
  // assistant half, a message the customer sent is never lost (§9.3).
  const userMessage = await prisma.message.create({
    data: {
      conversationId: input.conversationId,
      role: MessageRole.USER,
      content: input.content,
      ...(input.clientMessageId === undefined ? {} : { clientMessageId: input.clientMessageId }),
    },
  });
  await touchConversation(input.conversationId);

  // The gate reads the state itself, *after* the customer's message is stored, rather than
  // trusting a status the caller read earlier. The window is small either way, but this is
  // the read that decides whether an AI call happens at all: an agent who claimed the
  // conversation between the authorization read and here must be visible to Phase 1, or the
  // bot answers a conversation a human already owns (§8.1).
  const opened = await readTurnState(input.conversationId);

  // The customer's message is committed, so it is announced now rather than after generation
  // (§12.2). Waiting for the AI would delay the customer's own words reaching the agent who
  // is watching this conversation by however long the model takes — and on a suppressed turn
  // there is no later moment to announce them from at all.
  emitMessageCreated(opened.workspaceId, userMessage);
  if (isQueueVisible(opened.status)) {
    emitQueueUpdated(opened.workspaceId, {
      conversationId: input.conversationId,
      status: opened.status,
    });
  }

  let status = opened.status;
  let expectedVersion = opened.version;

  // --- Customer-driven reopen (§8.3, default `REOPEN_TO_AI`) ---------------------------
  // A message on a closed conversation re-engages the bot rather than being refused. The
  // transition is guarded on `RESOLVED`, so two messages arriving together cannot both
  // reopen — the loser gets a conflict and the caller retries against the new state.
  if (status === ConversationStatus.RESOLVED) {
    const reopened = await commitTransition({
      conversationId: input.conversationId,
      guard: { status: ConversationStatus.RESOLVED },
      data: {
        status: ConversationStatus.ACTIVE,
        // Cleared so a former agent is not woken by an answer the AI is about to give.
        assignedAgentId: null,
        resolvedAt: null,
        version: bumpVersion,
      },
      eventType: ConversationEventType.REOPENED,
      actorId: null,
      metadata: { actor: 'CUSTOMER', previousStatus: ConversationStatus.RESOLVED },
      onConflict: () => new ConflictError('This conversation is no longer resolved'),
    });

    status = reopened.status;
    // The reopen bumped the version, so the expectation moves with it — otherwise Phase 3
    // would discard the very answer the reopen was performed to obtain.
    expectedVersion = reopened.version;

    // Emitted post-commit like every other notification. A resolved conversation is listed by
    // the queue's resolved view and by nothing else, so re-engaging it moves it out of one
    // view and (once it escalates) into another.
    emitLifecycleNotification('conversation:reopened', reopened, null);
  }

  // --- Phase 1: pre-flight gate ---------------------------------------------------------
  if (status !== ConversationStatus.ACTIVE) {
    logger.info(
      { conversationId: input.conversationId, status },
      'AI bypassed: a human owns this conversation'
    );
    return {
      userMessage,
      assistantMessage: null,
      ai: null,
      suppressed: true,
      suppressionReason: 'AI_BYPASSED',
    };
  }

  // --- Phase 2: in-flight cancellation --------------------------------------------------
  const controller = startAITurn(input.conversationId);

  let ai: ChatResponse;
  try {
    ai = await generateResponse(input.botId, input.content, config, controller.signal);
  } catch (err) {
    // An abort is our own decision arriving back as an exception. Any other failure is a
    // real AI-service fault and must surface as one.
    if (controller.signal.aborted) {
      logger.info(
        { conversationId: input.conversationId },
        'AI turn cancelled: the conversation left ACTIVE during generation'
      );
      return {
        userMessage,
        assistantMessage: null,
        ai: null,
        suppressed: true,
        suppressionReason: 'ABORTED',
      };
    }
    throw err;
  } finally {
    endAITurn(input.conversationId, controller);
  }

  const decision = decideEscalation(config, ai, new Date());

  // Resolved before the transaction so the transaction stays short: it is a read of Node's
  // own mirrored rows, and there is no reason to hold a write lock across it.
  const sources = config.knowledge.showSources
    ? await resolveSourceLabels(ai.sources, input.botId)
    : null;

  // --- Phase 3: post-generation optimistic conditional commit --------------------------
  const outcome = await prisma.$transaction(async (tx) => {
    const current = await tx.conversation.findUnique({
      where: { id: input.conversationId },
      select: { status: true, version: true },
    });

    /**
     * The escalation this transaction commits, if any — carried out of the callback so the
     * notification is built from what was *written* rather than from what was decided. The
     * two agree here; deriving the event from the write is what keeps them agreeing if the
     * transaction ever grows a branch that declines the escalation.
     */
    let escalation: {
      escalatedAt: Date;
      reason: string | null;
      offHours: boolean;
    } | null = null;

    if (
      !current ||
      current.status !== ConversationStatus.ACTIVE ||
      current.version !== expectedVersion
    ) {
      logger.warn(
        {
          conversationId: input.conversationId,
          currentStatus: current?.status,
          expectedVersion,
          currentVersion: current?.version,
        },
        'Discarding stale AI response: conversation transitioned during AI generation'
      );
      return { discarded: true as const };
    }

    const assistantMessage = await tx.message.create({
      data: {
        conversationId: input.conversationId,
        role: MessageRole.ASSISTANT,
        content: decision.response,
        // Persisted only when sources are enabled *and* something was cited. The default
        // path writes no new data, which is what keeps existing bots' rows unchanged (§15.3).
        ...(sources && sources.length > 0
          ? { sources: sources as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });

    if (decision.escalate) {
      // One timestamp for both the persisted row and the notification that describes it. Two
      // `new Date()` calls would make the event's `escalatedAt` differ by milliseconds from
      // the row's, and a client that reconciles the two would find a disagreement that is not
      // a real one.
      const escalatedAt = new Date();

      // Status, escalation metadata and the audit event commit together, so a reader never
      // sees a `WAITING_FOR_HUMAN` row with no reason and no history (§22).
      await tx.conversation.update({
        where: { id: input.conversationId },
        data: {
          status: ConversationStatus.WAITING_FOR_HUMAN,
          escalatedAt,
          escalationReason: decision.reason,
          escalatedOffHours: decision.offHours,
          version: bumpVersion,
        },
      });
      await tx.conversationEvent.create({
        data: {
          conversationId: input.conversationId,
          actorId: null,
          eventType: ConversationEventType.ESCALATED,
          metadata: { reason: decision.reason, offHours: decision.offHours },
        },
      });

      escalation = {
        escalatedAt,
        reason: decision.reason,
        offHours: decision.offHours,
      };
    } else {
      await tx.conversation.update({
        where: { id: input.conversationId },
        data: { version: bumpVersion },
      });
    }

    return { discarded: false as const, assistantMessage, escalation };
  });

  if (outcome.discarded) {
    return {
      userMessage,
      assistantMessage: null,
      ai: null,
      suppressed: true,
      suppressionReason: 'STALE',
    };
  }

  // Both halves of the turn are now durable, so both are announced (§12.2).
  emitMessageCreated(opened.workspaceId, outcome.assistantMessage);

  if (outcome.escalation) {
    // The ticket has just entered the queue: every agent watching it needs to see the row
    // appear, and the customer needs to know a human is coming (§16.1).
    emitConversationEvent(opened.workspaceId, 'conversation:escalated', {
      conversationId: input.conversationId,
      status: ConversationStatus.WAITING_FOR_HUMAN,
      // Escalation is only reachable from `ACTIVE`, which by definition has no assignee.
      assignedAgentId: null,
      escalatedAt: outcome.escalation.escalatedAt.toISOString(),
      escalationReason: outcome.escalation.reason,
      escalatedOffHours: outcome.escalation.offHours,
      occurredAt: outcome.escalation.escalatedAt.toISOString(),
    });
    emitQueueUpdated(opened.workspaceId, {
      conversationId: input.conversationId,
      status: ConversationStatus.WAITING_FOR_HUMAN,
    });
  }

  // The escalation just landed, so any *other* turn still generating for this conversation
  // is now answering a question nobody asked.
  if (decision.escalate) {
    abortActiveAITurn(input.conversationId);
  }

  const result: SendMessageResult = {
    userMessage,
    assistantMessage: outcome.assistantMessage,
    // The customer-facing answer reflects the policy decision; `ai` still carries the raw
    // reason, retrieval metadata and the Node-only model fields.
    ai: { ...ai, response: decision.response },
    suppressed: false,
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
 * A message from a workspace member on the dashboard (spec §14).
 *
 * Authorization is the membership query; the turn itself is shared with the customer path
 * so the two can never drift on the concurrency rules.
 */
export const addMessage = async (
  conversationId: string,
  userId: string,
  content: string
): Promise<SendMessageResult> => {
  const conversation = await assertConversationAccess(conversationId, userId);

  return runTurn({ conversationId, botId: conversation.botId, content });
};

/**
 * A message from the customer, over the public surface (§9.3).
 *
 * The visitor token has already proven this conversation is theirs — `authenticateVisitor`
 * verified the scope claim against the path *and* re-read the row — so there is no
 * membership check to make here and no `userId` to pass. That is the whole reason the
 * customer path has its own entry point rather than reusing `addMessage` with a null user.
 */
export const addCustomerMessage = async (
  conversationId: string,
  botId: string,
  content: string,
  clientMessageId?: string
): Promise<SendMessageResult> =>
  runTurn({
    conversationId,
    botId,
    content,
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
  });

/**
 * Persist an agent's reply (§8.2, §14).
 *
 * No version bump, deliberately. `version` exists to invalidate an in-flight AI turn, and
 * the AI is already suppressed in every state an agent can reply from — so bumping it here
 * would invalidate nothing while making the token mean two different things. `updatedAt`
 * *is* moved, because that is what orders an agent's own queue.
 *
 * The transaction keeps the message and its `AGENT_REPLIED` audit row inseparable, the same
 * guarantee every lifecycle transition makes.
 */
export const addAgentMessage = async (
  conversationId: string,
  workspaceId: string,
  agentId: string,
  content: string
): Promise<Message> => {
  const state = await readLifecycleState(conversationId, workspaceId);

  if (state.status === ConversationStatus.RESOLVED) {
    throw new ValidationError('This conversation is resolved. Reopen it before replying.');
  }

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        conversationId,
        role: MessageRole.AGENT,
        content,
        senderId: agentId,
      },
    });

    await tx.conversationEvent.create({
      data: { conversationId, actorId: agentId, eventType: ConversationEventType.AGENT_REPLIED },
    });

    await tx.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return created;
  });

  // Post-commit. The agent's reply is the change every other watcher of this conversation is
  // waiting for — the customer most of all — so it is announced the moment it is durable.
  // The queue is nudged too: the reply moved `updatedAt`, which is what orders the agent's
  // own assigned list.
  emitMessageCreated(workspaceId, message);
  emitQueueUpdated(workspaceId, { conversationId, status: state.status });

  return message;
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
  config: ResolvedBotConfig,
  signal?: AbortSignal
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

  return aiServiceClient.chat(
    {
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
    },
    // Phase 2 (§9.2): the caller's cancellation signal, threaded to the HTTP request so a
    // conversation that leaves ACTIVE mid-generation stops costing tokens immediately.
    signal
  );
};

// =======================================================================================
// Human escalation: queue, claiming, assignment and lifecycle control
// (HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md §8, §11, §12)
//
// Every function below obeys the same three rules, which is what makes the state machine
// trustworthy rather than merely implemented:
//
//   1. **The workspace is part of the query, never a separate check.** A conversation that
//      is not in the caller's workspace is a 404, so a foreign tenant is indistinguishable
//      from a missing row. Filtering by `workspaceId` in the same `where` clause means
//      there is no window between "is it mine?" and "change it".
//   2. **The precondition lives in the UPDATE's WHERE clause.** Claiming is not
//      read-then-write; the guard is part of the atomic statement, so two concurrent claims
//      cannot both see an unassigned row and both write. Under READ COMMITTED the second
//      UPDATE blocks on the row lock, re-evaluates its predicate against the committed row,
//      matches nothing, and is reported as a 409.
//   3. **The audit row commits with the transition.** `commitTransition` writes both inside
//      one transaction, so a state change whose `ConversationEvent` is missing (or an event
//      describing a change that rolled back) cannot exist.
// =======================================================================================

/** Default page size for a queue listing. */
const DEFAULT_QUEUE_LIMIT = 25;

/**
 * The queue projection.
 *
 * Deliberately a summary, not a transcript: it carries the fields the inbox list renders
 * (who, which bot, how long they have waited) and the single newest message as a preview.
 * `contact` is **excluded** — email, phone and order id are PII, and §18.2 requires them to
 * be fetched only for the one conversation an agent has actually opened.
 */
const queueItemSelect = {
  id: true,
  botId: true,
  workspaceId: true,
  status: true,
  assignedAgentId: true,
  escalatedAt: true,
  escalationReason: true,
  escalatedOffHours: true,
  resolvedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  bot: { select: { id: true, name: true } },
  assignedAgent: { select: { id: true, name: true } },
  messages: {
    take: 1,
    orderBy: { createdAt: 'desc' },
    select: { role: true, content: true, createdAt: true },
  },
} satisfies Prisma.ConversationSelect;

export type QueueItem = Prisma.ConversationGetPayload<{ select: typeof queueItemSelect }>;

export interface QueueResult {
  items: QueueItem[];
  pagination: { limit: number; hasMore: boolean };
}

/** The predicate each queue tab applies, on top of the workspace scope. */
const queueViewFilter = (
  view: QueueViewInput,
  userId: string
): Prisma.ConversationWhereInput => {
  switch (view) {
    case 'unassigned':
      // "In the queue" means escalated *and* unowned. Both halves matter: a conversation
      // that is somehow WAITING_FOR_HUMAN with an owner must not appear as claimable.
      return { status: ConversationStatus.WAITING_FOR_HUMAN, assignedAgentId: null };
    case 'assigned':
      return { status: ConversationStatus.HUMAN_ACTIVE, assignedAgentId: userId };
    case 'all_active':
      return {
        status: { in: [ConversationStatus.WAITING_FOR_HUMAN, ConversationStatus.HUMAN_ACTIVE] },
      };
    case 'resolved':
      return { status: ConversationStatus.RESOLVED };
  }
};

/**
 * Ordering per tab.
 *
 * The waiting queues are strictly FIFO by **escalation** time, not creation time: a
 * conversation may chat with the bot for ten minutes before a human is ever needed, so
 * ordering by `createdAt` would serve the wrong customer first. `createdAt` is the
 * tie-breaker, because two conversations can escalate within the same millisecond and an
 * unstable order would make the same ticket jump around between polls.
 */
const queueViewOrder = (
  view: QueueViewInput
): Prisma.ConversationOrderByWithRelationInput[] => {
  switch (view) {
    case 'unassigned':
    case 'all_active':
      return [{ escalatedAt: 'asc' }, { createdAt: 'asc' }];
    case 'assigned':
      // An agent's own tickets: whatever they last touched is what they are working on.
      return [{ updatedAt: 'desc' }];
    case 'resolved':
      return [{ resolvedAt: 'desc' }];
  }
};

type QueueViewInput = 'unassigned' | 'assigned' | 'all_active' | 'resolved';

/**
 * List a workspace's support queue.
 *
 * The workspace comes from `req.workspaceContext` — already proven to be one the caller
 * belongs to — so this function never has to re-derive or re-check membership.
 */
export const listQueueConversations = async (
  workspaceId: string,
  userId: string,
  options: { view: QueueViewInput; botId?: string; limit?: number }
): Promise<QueueResult> => {
  const limit = options.limit ?? DEFAULT_QUEUE_LIMIT;

  // One extra row answers "is there more?" without a second COUNT query over the same
  // predicate, and the extra row is dropped before it reaches the caller.
  const rows = await prisma.conversation.findMany({
    where: {
      workspaceId,
      ...(options.botId ? { botId: options.botId } : {}),
      ...queueViewFilter(options.view, userId),
    },
    orderBy: queueViewOrder(options.view),
    take: limit + 1,
    select: queueItemSelect,
  });

  const hasMore = rows.length > limit;

  return {
    items: hasMore ? rows.slice(0, limit) : rows,
    pagination: { limit, hasMore },
  };
};

/** A conversation's lifecycle state, read inside a transaction. */
interface LifecycleState {
  id: string;
  status: ConversationStatus;
  assignedAgentId: string | null;
  escalatedAt: Date | null;
}

/**
 * Read a conversation's current lifecycle state, scoped to the workspace.
 *
 * This read exists to produce a *precise* error ("already claimed" vs "resolved"), not to
 * authorize the write — the guarded UPDATE does that. It is therefore allowed to be
 * advisory: if it races, the guard still refuses the write.
 */
const readLifecycleState = async (
  conversationId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma
): Promise<LifecycleState> => {
  const conversation = await tx.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: { id: true, status: true, assignedAgentId: true, escalatedAt: true },
  });

  if (!conversation) {
    // Same answer for "does not exist" and "belongs to another tenant" (§18.1).
    throw new NotFoundError('Conversation not found');
  }

  return conversation;
};

/** Prisma reports "the UPDATE matched no row" as P2025. */
const isRecordNotFound = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025';

/**
 * Commit one lifecycle transition atomically.
 *
 * `guard` is merged into the UPDATE's `where`, so it is evaluated by the database at write
 * time. When it matches nothing, the caller's `onConflict` explains why in the caller's own
 * terms — a claim race and an assign race deserve different messages.
 *
 * `precondition` runs first inside the same transaction, for checks that must not be
 * separable from the write (the assignment target's workspace membership).
 *
 * The update payload is the *unchecked* variant so the scalar `assignedAgentId` can be
 * written directly: the checked variant only accepts a relation operation, which would turn
 * a validated write into a nested connect.
 */
const commitTransition = async (params: {
  conversationId: string;
  /**
   * The state the conversation must still be in for the write to land. `id` is excluded
   * because it is supplied separately and is always the unique key — a guard that could
   * also constrain `id` would be a second, disagreeing source of identity.
   */
  guard: Omit<Prisma.ConversationWhereInput, 'id'>;
  data: Prisma.ConversationUncheckedUpdateInput;
  eventType: ConversationEventType;
  actorId: string | null;
  metadata?: Prisma.InputJsonValue;
  onConflict: () => Error;
  precondition?: (tx: Prisma.TransactionClient) => Promise<void>;
}): Promise<Conversation> => {
  const { conversationId, guard, data, eventType, actorId, metadata, onConflict, precondition } =
    params;

  try {
    return await prisma.$transaction(async (tx) => {
      if (precondition) {
        await precondition(tx);
      }

      const updated = await tx.conversation.update({
        where: { id: conversationId, ...guard },
        data,
      });

      await tx.conversationEvent.create({
        data: {
          conversationId,
          actorId,
          eventType,
          ...(metadata === undefined ? {} : { metadata }),
        },
      });

      return updated;
    });
  } catch (err) {
    if (isRecordNotFound(err)) {
      throw onConflict();
    }
    throw err;
  }
};

/** Every transition advances the optimistic-concurrency token (§13.1). */
const bumpVersion = { increment: 1 } as const;

/**
 * The lifecycle transitions the realtime layer announces (HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md
 * §14, §15.3.1).
 *
 * `REASSIGNED` is absent on purpose. The plan's realtime vocabulary has a single name for
 * "the assignee of this conversation changed", and a client renders an assignment and a
 * reassignment identically — by reading the new assignee. The audit trail keeps them apart
 * because "was this ever reassigned?" is a question about history, which the live event is
 * not answering.
 */
type LifecycleEventName =
  | 'conversation:claimed'
  | 'conversation:assigned'
  | 'conversation:unassigned'
  | 'conversation:resolved'
  | 'conversation:reopened';

/**
 * Announce a committed lifecycle transition.
 *
 * Takes the row the transition wrote rather than the intent that produced it, so the event
 * describes the state that actually landed. A transition that loses its guard race never
 * reaches this call — `commitTransition` throws instead — and the winner's own call is the
 * only one made, which is what keeps two racing agents from both being told they claimed.
 *
 * Every one of these five transitions changes the queue: it moves the ticket between the
 * unassigned, assigned and resolved views, or between two agents' lists. So the queue nudge is
 * unconditional here rather than a per-caller decision — there is no transition in this set
 * that leaves every agent's view unchanged.
 */
const emitLifecycleNotification = (
  event: LifecycleEventName,
  conversation: Conversation,
  actorId: string | null
): void => {
  emitConversationEvent(conversation.workspaceId, event, {
    conversationId: conversation.id,
    status: conversation.status,
    assignedAgentId: conversation.assignedAgentId,
    version: conversation.version,
    actorId,
    occurredAt: new Date().toISOString(),
  });

  emitQueueUpdated(conversation.workspaceId, {
    conversationId: conversation.id,
    status: conversation.status,
  });
};

/**
 * Claim an unassigned conversation from the queue (§8.2).
 *
 * The 409 is the whole point: two agents clicking "Claim" at the same moment must produce
 * exactly one owner. The second request is not an error in the caller's input — it is a
 * correct answer about a world that changed — which is why it is a conflict, not a 400.
 */
export const claimConversation = async (
  conversationId: string,
  workspaceId: string,
  userId: string
): Promise<Conversation> => {
  const state = await readLifecycleState(conversationId, workspaceId);

  if (state.status === ConversationStatus.HUMAN_ACTIVE) {
    throw new ConflictError('This conversation has already been claimed');
  }
  if (state.status === ConversationStatus.RESOLVED) {
    // Not a race: no concurrent actor can produce this, and reopening is the documented
    // way forward — so this is a bad request, not a conflict.
    throw new ValidationError('This conversation is resolved. Reopen it before claiming it.');
  }
  if (state.status !== ConversationStatus.WAITING_FOR_HUMAN) {
    throw new ConflictError('This conversation is not waiting for a human agent');
  }

  const claimed = await commitTransition({
    conversationId,
    // The guard, not the read above, is what makes this safe.
    guard: { status: ConversationStatus.WAITING_FOR_HUMAN, assignedAgentId: null },
    data: {
      status: ConversationStatus.HUMAN_ACTIVE,
      assignedAgentId: userId,
      version: bumpVersion,
    },
    eventType: ConversationEventType.CLAIMED,
    actorId: userId,
    onConflict: () => new ConflictError('This conversation was claimed by another agent'),
  });

  // Phase 2 (§9.2): a turn started while the conversation was still `ACTIVE` may still be
  // generating. Aborting it here saves the LLM call; Phase 3 is what makes the discard
  // certain, including on an instance that never saw this claim.
  abortActiveAITurn(conversationId);

  // Post-commit: the claim is durable, so the ticket leaves every other agent's unassigned
  // view — and a stale click on it must now lose the guard race rather than this event.
  emitLifecycleNotification('conversation:claimed', claimed, userId);

  return claimed;
};

/**
 * Verify a user is a member of the workspace, inside the caller's transaction (§11.2).
 *
 * The `assignedAgentId` foreign key only proves the user exists *on the platform*. It says
 * nothing about which tenant they belong to, so without this check an administrator could
 * assign a conversation to an agent in another workspace and hand them a transcript they
 * were never entitled to read.
 */
const assertWorkspaceMember = async (
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string
): Promise<void> => {
  const member = await tx.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true },
  });

  if (!member) {
    throw new ValidationError('That user is not a member of this workspace');
  }
};

/**
 * Assign or reassign a conversation to an agent (ADMIN/OWNER only — `conversations:assign`).
 *
 * `ASSIGNED` and `REASSIGNED` are separate events because they are different facts: one
 * put a ticket in someone's hands, the other took it out of one person's and gave it to
 * another. Collapsing them would make the audit trail unable to answer "was this ever
 * reassigned?", which is the question the trail exists to answer.
 */
export const assignConversation = async (
  conversationId: string,
  workspaceId: string,
  actorId: string,
  targetAgentId: string
): Promise<Conversation> => {
  const state = await readLifecycleState(conversationId, workspaceId);

  if (state.status === ConversationStatus.RESOLVED) {
    throw new ValidationError('This conversation is resolved. Reopen it before assigning it.');
  }
  if (state.assignedAgentId === targetAgentId) {
    throw new ConflictError('That agent is already handling this conversation');
  }

  const isReassignment = state.assignedAgentId !== null;

  const assigned = await commitTransition({
    conversationId,
    // Assignable from the queue or from another agent, but never from RESOLVED.
    guard: {
      status: { in: [ConversationStatus.WAITING_FOR_HUMAN, ConversationStatus.HUMAN_ACTIVE] },
    },
    data: {
      status: ConversationStatus.HUMAN_ACTIVE,
      assignedAgentId: targetAgentId,
      version: bumpVersion,
    },
    eventType: isReassignment
      ? ConversationEventType.REASSIGNED
      : ConversationEventType.ASSIGNED,
    actorId,
    metadata: { previousAgentId: state.assignedAgentId, targetAgentId },
    precondition: (tx) => assertWorkspaceMember(tx, workspaceId, targetAgentId),
    onConflict: () => new ConflictError('This conversation changed while you were assigning it'),
  });

  // Phase 2 (§9.2): assignment also takes the conversation away from the AI, so any turn
  // still generating against the old `ACTIVE` state is cut off.
  abortActiveAITurn(conversationId);

  // Announced under one name whether this was an assignment or a reassignment (see
  // `LifecycleEventName`): the agent who lost the ticket and the agent who gained it both
  // react by re-reading the assignee.
  emitLifecycleNotification('conversation:assigned', assigned, actorId);

  return assigned;
};

/**
 * Return a conversation to the queue (§8.2).
 *
 * Two different acts share this endpoint and are separated by who is asking:
 *   - the **assigned agent** handing back their own ticket — `conversations:claim`, because
 *     it is the exact inverse of claiming, and an AGENT holds it;
 *   - an **administrator** taking a ticket off someone else — `conversations:assign`,
 *     because it moves work away from another person. The route's `conversations:claim`
 *     gate is broad enough to admit both, so the narrower rule is enforced here, where the
 *     current assignee is known.
 *
 * `HUMAN_ACTIVE → WAITING_FOR_HUMAN` is the only legal direction. Invariant #2 does not
 * merely prefer it: a conversation cannot sit in `HUMAN_ACTIVE` with no agent, so
 * unassigning *must* re-queue rather than leave the row in place.
 */
export const unassignConversation = async (
  conversationId: string,
  workspaceId: string,
  actorId: string,
  actorRole: WorkspaceRole
): Promise<Conversation> => {
  const state = await readLifecycleState(conversationId, workspaceId);

  if (state.status !== ConversationStatus.HUMAN_ACTIVE) {
    throw new ValidationError('This conversation is not currently being handled by an agent');
  }

  const isSelfUnassign = state.assignedAgentId === actorId;

  if (!isSelfUnassign && !hasPermission(actorRole, PERMISSIONS.CONVERSATIONS_ASSIGN)) {
    throw new ForbiddenError(
      'Only the assigned agent or an administrator can return this conversation to the queue'
    );
  }

  const unassigned = await commitTransition({
    conversationId,
    guard: { status: ConversationStatus.HUMAN_ACTIVE },
    data: {
      status: ConversationStatus.WAITING_FOR_HUMAN,
      assignedAgentId: null,
      version: bumpVersion,
    },
    eventType: ConversationEventType.UNASSIGNED,
    actorId,
    metadata: {
      previousAgentId: state.assignedAgentId,
      reason: isSelfUnassign ? 'SELF_UNASSIGNED' : 'ADMIN_UNASSIGNED',
    },
    onConflict: () =>
      new ConflictError('This conversation is no longer being handled by an agent'),
  });

  emitLifecycleNotification('conversation:unassigned', unassigned, actorId);

  return unassigned;
};

/**
 * Close a conversation (§8.2).
 *
 * Resolving from `HUMAN_ACTIVE` **retains** the assignee: the ticket records who dealt with
 * it, and reopening therefore has an owner to credit. Resolving from `WAITING_FOR_HUMAN`
 * (spam, a duplicate, a question the customer answered themselves) leaves the assignment
 * null, because there never was one.
 */
export const resolveConversation = async (
  conversationId: string,
  workspaceId: string,
  actorId: string
): Promise<Conversation> => {
  const state = await readLifecycleState(conversationId, workspaceId);

  if (state.status === ConversationStatus.RESOLVED) {
    throw new ValidationError('This conversation is already resolved');
  }

  const resolved = await commitTransition({
    conversationId,
    guard: { status: { not: ConversationStatus.RESOLVED } },
    data: {
      status: ConversationStatus.RESOLVED,
      resolvedAt: new Date(),
      version: bumpVersion,
    },
    eventType: ConversationEventType.RESOLVED,
    actorId,
    metadata: { previousStatus: state.status, previousAgentId: state.assignedAgentId },
    onConflict: () => new ValidationError('This conversation is already resolved'),
  });

  // The customer's window stays open on a resolved conversation (§8.3), so this is not
  // merely housekeeping for agents: it is how the visitor learns the ticket is closed.
  emitLifecycleNotification('conversation:resolved', resolved, actorId);

  return resolved;
};

/**
 * Reopen a resolved conversation from the dashboard (§8.2, §8.3).
 *
 * This is the *agent* half of the reopen policy. The customer half — a new message landing
 * on a resolved conversation — is a different transition with a different destination
 * (`ACTIVE`, or the queue under `reopenBehavior`), and belongs to the customer-driven path
 * in CP3. Here the ticket returns directly to a human, assigned to whoever reopened it, so
 * it does not have to be re-claimed from the queue.
 */
export const reopenConversation = async (
  conversationId: string,
  workspaceId: string,
  actorId: string
): Promise<Conversation> => {
  const state = await readLifecycleState(conversationId, workspaceId);

  if (state.status !== ConversationStatus.RESOLVED) {
    throw new ValidationError('Only a resolved conversation can be reopened');
  }

  const reopened = await commitTransition({
    conversationId,
    guard: { status: ConversationStatus.RESOLVED },
    data: {
      status: ConversationStatus.HUMAN_ACTIVE,
      assignedAgentId: actorId,
      resolvedAt: null,
      version: bumpVersion,
    },
    eventType: ConversationEventType.REOPENED,
    actorId,
    metadata: { actor: 'AGENT', previousStatus: ConversationStatus.RESOLVED },
    onConflict: () => new ConflictError('This conversation is no longer resolved'),
  });

  emitLifecycleNotification('conversation:reopened', reopened, actorId);

  return reopened;
};

/**
 * A conversation's audit trail, newest first.
 *
 * Reads are workspace-scoped like every other conversation access, so a foreign
 * conversation id is a 404 rather than an empty history.
 */
export const listConversationEvents = async (
  conversationId: string,
  workspaceId: string
): Promise<
  {
    id: string;
    eventType: ConversationEventType;
    actorId: string | null;
    actor: { id: string; name: string } | null;
    metadata: Prisma.JsonValue;
    createdAt: Date;
  }[]
> => {
  await readLifecycleState(conversationId, workspaceId);

  return prisma.conversationEvent.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      eventType: true,
      actorId: true,
      actor: { select: { id: true, name: true } },
      metadata: true,
      createdAt: true,
    },
  });
};

/**
 * Return every conversation a departing member was handling to the unassigned queue (§11.3).
 *
 * Takes the caller's transaction client rather than opening its own: this must commit with
 * the membership delete that caused it. Otherwise a crash in between leaves tickets owned
 * by someone who is no longer in the workspace — invisible to every queue, since they are
 * neither unassigned nor owned by a current member.
 *
 * The former agent is recorded in `metadata` and `actorId` stays null: nobody *decided* to
 * unassign these tickets, a membership change made them unassignable.
 *
 * Returns the ids of the conversations it released — not a count — because the caller has to
 * name each one in the realtime notification that follows (§14's `conversation:unassigned`),
 * and re-deriving them would be a second query over a set that has already changed.
 */
export const releaseConversationsForRevokedMember = async (
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string
): Promise<string[]> => {
  const affected = await tx.conversation.findMany({
    where: {
      workspaceId,
      assignedAgentId: userId,
      status: ConversationStatus.HUMAN_ACTIVE,
    },
    select: { id: true },
  });

  if (affected.length === 0) {
    return [];
  }

  const ids = affected.map((conversation) => conversation.id);

  await tx.conversation.updateMany({
    where: { id: { in: ids } },
    data: {
      status: ConversationStatus.WAITING_FOR_HUMAN,
      assignedAgentId: null,
      version: bumpVersion,
    },
  });

  await tx.conversationEvent.createMany({
    data: ids.map((conversationId) => ({
      conversationId,
      eventType: ConversationEventType.UNASSIGNED,
      metadata: { reason: 'MEMBERSHIP_REVOKED', previousAgentId: userId },
    })),
  });

  return ids;
};

/**
 * Announce the tickets a membership revocation returned to the queue (§11.3, §20).
 *
 * Lives here rather than in the member service because the event name, the resulting status
 * and the payload shape are this module's vocabulary — the member service is reporting *what
 * happened to conversations*, and that report should not be assembled from outside the module
 * that owns the lifecycle.
 *
 * `version` is omitted: the release was a `updateMany`, so no row was returned and no version
 * was read. Inventing one would be worse than leaving it out — a client that trusted it would
 * be holding an optimistic-concurrency token that corresponds to nothing. The field is
 * optional in the payload for exactly this case.
 */
export const announceRevokedMemberReleases = (
  workspaceId: string,
  conversationIds: string[]
): void => {
  for (const conversationId of conversationIds) {
    emitConversationEvent(workspaceId, 'conversation:unassigned', {
      conversationId,
      status: ConversationStatus.WAITING_FOR_HUMAN,
      assignedAgentId: null,
      actorId: null,
      occurredAt: new Date().toISOString(),
    });

    emitQueueUpdated(workspaceId, {
      conversationId,
      status: ConversationStatus.WAITING_FOR_HUMAN,
    });
  }
};

// =======================================================================================
// Public visitor sessions (§10)
//
// The customer surface, and the only part of this service reachable without a workspace
// membership. Authorization is a scoped visitor token (§10.4) plus, for renewal, a 32-byte
// secret that never leaves the customer's browser in plaintext — only its SHA-256 digest is
// stored, so a database read does not hand an attacker a usable credential (§10.1).
// =======================================================================================

/** 32 bytes, per §10.3 — the size that makes the secret unguessable rather than merely long. */
const VISITOR_SESSION_SECRET_BYTES = 32;

export interface PublicConversationStart {
  conversation: Conversation;
  /** Short-lived (15 min) scoped token. Safe in memory or `sessionStorage`. */
  visitorToken: string;
  /**
   * The long-lived half, returned **exactly once**, here. It is never persisted in plaintext
   * and can never be read back, so a customer who loses it starts a new conversation.
   */
  sessionSecret: string;
}

/**
 * Start a conversation from the embedded widget (§10.3).
 *
 * No authentication, by design — this is the endpoint that *creates* the credential. Two
 * things protect it: the bot must exist and be switched on, and the route is IP rate-limited
 * (spec §14). Both failures answer 404, so the endpoint cannot be used to discover which
 * bots exist but are paused.
 *
 * The conversation is created with its `visitorSessionHash` in the same insert, so there is
 * no window in which a conversation exists that no visitor can ever legitimately claim.
 */
export const startPublicConversation = async (botId: string): Promise<PublicConversationStart> => {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { id: true, workspaceId: true, isActive: true },
  });

  if (!bot || !bot.isActive) {
    throw new NotFoundError('Bot not found');
  }

  const sessionSecret = randomBytes(VISITOR_SESSION_SECRET_BYTES).toString('hex');

  const conversation = await prisma.conversation.create({
    data: {
      botId: bot.id,
      workspaceId: bot.workspaceId,
      visitorSessionHash: sha256Hex(sessionSecret),
    },
  });

  return {
    conversation,
    visitorToken: signVisitorToken({
      conversationId: conversation.id,
      botId: bot.id,
      workspaceId: bot.workspaceId,
    }),
    sessionSecret,
  };
};

/** Constant-time comparison of two hex digests of the same length. */
const digestsMatch = (presentedHex: string, storedHex: string): boolean => {
  const presented = Buffer.from(presentedHex, 'hex');
  const stored = Buffer.from(storedHex, 'hex');

  // A malformed secret decodes to a shorter buffer; `timingSafeEqual` throws on a length
  // mismatch, so the length is compared first and both sides are fixed-length hex digests.
  if (presented.length !== stored.length) return false;

  return timingSafeEqual(presented, stored);
};

/**
 * Exchange a session secret for a fresh visitor token (§10.3).
 *
 * The token presented here is expected to be **expired** — that is the point of the
 * endpoint — so the route runs `authenticateVisitor({ allowExpired: true })`. The secret is
 * the credential; the token only has to prove which conversation is being renewed, and it
 * still has to carry a valid signature for that.
 *
 * Renewal is refused for a resolved conversation: a closed ticket is not a live session, and
 * letting it renew would hand back a token for a conversation the visitor can no longer act
 * on. The customer's route back in is a new message, which reopens (§8.3).
 */
export const refreshVisitorSession = async (
  conversationId: string,
  sessionSecret: string
): Promise<{ visitorToken: string }> => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      botId: true,
      workspaceId: true,
      status: true,
      visitorSessionHash: true,
    },
  });

  // A conversation with no session hash was never a public one (a dashboard-created
  // conversation), so there is nothing here to renew and no distinct answer to give.
  if (!conversation || !conversation.visitorSessionHash) {
    throw new NotFoundError('Conversation not found');
  }

  if (!digestsMatch(sha256Hex(sessionSecret), conversation.visitorSessionHash)) {
    // 401, not 404: the conversation is already identified by a validly-signed token, so
    // there is nothing left to conceal — the secret is simply wrong.
    throw new AuthenticationError('Invalid session secret');
  }

  if (conversation.status === ConversationStatus.RESOLVED) {
    throw new ForbiddenError('This conversation is closed');
  }

  return {
    visitorToken: signVisitorToken({
      conversationId: conversation.id,
      botId: conversation.botId,
      workspaceId: conversation.workspaceId,
    }),
  };
};

/** The `(createdAt, id)` position a recovery fetch resumes from (§15.3.2). */
export interface MessageCursor {
  afterCreatedAt: Date;
  afterId: string;
}

/**
 * The keyset predicate for a recovery fetch (§15.3.2).
 *
 * Written as the tuple comparison the ordering uses — `(createdAt, id) > (afterCreatedAt,
 * afterId)` — expanded into the two clauses Prisma can express. The `OR` is not an
 * optimization detail: `createdAt > afterCreatedAt` alone would skip every message sharing
 * the cursor's timestamp but sorting after it, which is precisely the case a bot reply and
 * the escalation event it triggers produce.
 */
const afterCursor = (cursor: MessageCursor): Prisma.MessageWhereInput => ({
  OR: [
    { createdAt: { gt: cursor.afterCreatedAt } },
    {
      createdAt: cursor.afterCreatedAt,
      id: { gt: cursor.afterId },
    },
  ],
});

/**
 * One page of a transcript, with the cursor a client resumes from (§15.3.2, §15.3.4).
 *
 * Returns messages strictly *after* the cursor in `(createdAt, id)` order — not the tail
 * window the transcript endpoints return when no cursor is given. The two differ in
 * direction, and deliberately: a client opening a conversation wants the newest messages, a
 * client that lost its socket wants everything it has not seen. A single mode that tried to
 * serve both would have to guess which one the caller meant from the presence of a cursor,
 * and would then be wrong for the client that reconnects *and* opens a conversation.
 *
 * `nextCursor` is `null` only when the page was short. A full page means there may be more, and
 * a short page means the caller has caught up — returning a cursor there would invite a poll
 * that can never return anything. It is always present in the result, never omitted, so the
 * client has one field to test rather than two ways to express "nothing more".
 */
export const listConversationMessages = async (
  conversationId: string,
  workspaceId: string,
  options: { cursor?: MessageCursor; limit: number }
): Promise<{
  items: Message[];
  nextCursor: MessageCursor | null;
}> => {
  // Workspace-scoped like every other conversation read, so a foreign conversation id is a
  // 404 rather than an empty page. The gate is the state read, exactly as
  // `listConversationEvents` does it — the message query below is then free to filter on the
  // conversation alone, because the conversation has already been proven to be this tenant's.
  await readLifecycleState(conversationId, workspaceId);

  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      ...(options.cursor ? afterCursor(options.cursor) : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: options.limit + 1,
  });

  const hasMore = messages.length > options.limit;
  const items = hasMore ? messages.slice(0, options.limit) : messages;
  const last = items.at(-1);

  return {
    items,
    nextCursor:
      hasMore && last ? { afterCreatedAt: last.createdAt, afterId: last.id } : null,
  };
};

/**
 * The customer's own transcript (§14), cursor-aware since CP4 (§15.3.4).
 *
 * Written as its own projection rather than reusing `getConversationById`, because the two
 * audiences need different things and the difference is a security boundary, not a
 * formatting preference: this one returns **no** `senderId` and no message feedback. Which
 * staff member answered is internal information, and a customer-visible payload should not
 * be the place that starts leaking it. `role: AGENT` is enough for the widget to show that a
 * person replied (§17).
 */
export const getVisitorTranscript = async (
  conversationId: string,
  limit: number,
  cursor?: MessageCursor
): Promise<{
  conversation: {
    id: string;
    botId: string;
    status: ConversationStatus;
    escalatedAt: Date | null;
    resolvedAt: Date | null;
    createdAt: Date;
  };
  items: {
    id: string;
    role: MessageRole;
    content: string;
    sources: Prisma.JsonValue;
    createdAt: Date;
  }[];
  nextCursor: MessageCursor | null;
}> => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      botId: true,
      status: true,
      escalatedAt: true,
      resolvedAt: true,
      createdAt: true,
    },
  });

  if (!conversation) {
    throw new NotFoundError('Conversation not found');
  }

  const projection = {
    id: true,
    role: true,
    content: true,
    sources: true,
    createdAt: true,
  } as const;

  // Two directions, chosen by whether the caller is resuming or catching up. Both order by
  // `(createdAt, id)` so the two paths agree on what "next" means at a page boundary.
  if (cursor) {
    const page = await prisma.message.findMany({
      where: { conversationId, ...afterCursor(cursor) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: projection,
    });

    const hasMore = page.length > limit;
    const items = hasMore ? page.slice(0, limit) : page;
    const last = items.at(-1);

    return {
      conversation,
      items,
      nextCursor: hasMore && last ? { afterCreatedAt: last.createdAt, afterId: last.id } : null,
    };
  }

  // No cursor: the newest `limit` messages, then reversed. The widget needs the tail of a
  // long conversation, and taking the *oldest* N would show a returning customer the start
  // of a conversation they are trying to continue. Ordering by `(createdAt, id)` keeps the
  // page stable when two messages share a timestamp.
  const messages = await prisma.message.findMany({
    where: { conversationId },
    take: limit,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: projection,
  });

  return {
    conversation,
    items: messages.slice().reverse(),
    // A tail window is already the end of the conversation, so there is nothing to resume
    // from — a cursor here would point at the newest message and return an empty page.
    nextCursor: null,
  };
};