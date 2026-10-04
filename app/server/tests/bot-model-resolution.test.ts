import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/**
 * Checkpoint 6 — runtime model resolution.
 *
 * The Runtime matrix from the plan's Testing Strategy, driven through the real route table
 * rather than by calling the resolver directly. That is deliberate: what matters is not
 * that `resolveBotModel` returns an object, but that the object it returns decides whether
 * `aiServiceClient.chat` is called, with what payload, and what the customer sees when it
 * is not.
 *
 * `aiMock.chat` is the assertion of record throughout. A test that only checked the
 * response body would pass on a short-circuit that still spent provider money, so every
 * short-circuit case pins the call count at zero.
 */

const prismaMock = vi.hoisted(() => ({
  workspaceMember: { findUnique: vi.fn(), findFirst: vi.fn() },
  bot: { findUnique: vi.fn() },
  conversation: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  message: { create: vi.fn() },
  // Checkpoint 5: the message path resolves the bot configuration as well as its model.
  botConfiguration: { findUnique: vi.fn() },
  knowledgeSource: { findMany: vi.fn() },
}));

const aiMock = vi.hoisted(() => ({ chat: vi.fn() }));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');
const { MODEL_UNAVAILABLE_MESSAGE, AI_FAILURE_REASON } = await import(
  '../src/constants/aiFailure.js'
);

const USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'owner@example.com' };
const OTHER_USER = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'agent@example.com' };

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

/** The catalog row as the resolver's nested select returns it. */
const modelRow = (overrides: Record<string, unknown> = {}) => ({
  providerModelId: 'openai/gpt-4o-mini',
  enabled: true,
  provider: { slug: 'openrouter', enabled: true },
  ...overrides,
});

/**
 * Arrange the world for one `POST /conversations/:id/messages`.
 *
 * `bot.findUnique` is read **twice** on this route — once by the permission middleware,
 * which resolves `:conversationId` through the conversation, and once by the resolver. Only
 * the resolver's read is arranged here, because the middleware's scope resolution goes
 * through `conversation.findUnique`, primed separately below.
 */
const arrange = (resolution: unknown, user = USER) => {
  prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'member-1',
    userId: user.id,
    workspaceId: WORKSPACE_ID,
    role: 'OWNER',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID });
  // `isActive` answers the configuration read (Checkpoint 5) and the rest the model resolver;
  // a `null` resolution is left as `null` so the "unreadable bot row" case stays reachable.
  prismaMock.bot.findUnique.mockResolvedValue(
    resolution === null ? null : { isActive: true, ...(resolution as Record<string, unknown>) }
  );
  prismaMock.botConfiguration.findUnique.mockResolvedValue(null);
  prismaMock.message.create.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: args.data.role === 'USER' ? 'msg-user' : 'msg-assistant',
      conversationId: args.data.conversationId,
      role: args.data.role,
      content: args.data.content,
      createdAt: new Date(),
    })
  );
  prismaMock.conversation.update.mockResolvedValue({ id: CONVERSATION_ID, status: 'WAITING_FOR_HUMAN' });
};

const send = (user = USER, body: Record<string, unknown> = { content: 'Hello?' }) =>
  request(app)
    .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
    .set('Authorization', authHeader(user))
    .send(body);

/** The payload `aiServiceClient.chat` was called with, on its most recent call. */
const lastChatPayload = () => aiMock.chat.mock.calls.at(-1)?.[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  aiMock.chat.mockResolvedValue({
    status: 'success',
    response: 'Mock assistant reply',
    fallback_required: false,
  });
});

// ---------------------------------------------------------------------------------------
// Descriptor construction
// ---------------------------------------------------------------------------------------

describe('a bot with an assigned, enabled model', () => {
  it('sends the provider slug and the provider-native model id', async () => {
    arrange({ aiModelId: 'model-1', aiModel: modelRow() });

    const res = await send();

    expect(res.status).toBe(201);
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
    expect(lastChatPayload().model).toEqual({
      provider: 'openrouter',
      model_id: 'openai/gpt-4o-mini',
    });
    expect(res.body.data.ai.fallback_required).toBe(false);
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
  });

  it('reads the descriptor from the database, never from the request body', async () => {
    arrange({ aiModelId: 'model-1', aiModel: modelRow() });

    // A client naming a model directly. `createMessageSchema` strips unknown keys, so this
    // never survives validation — and even if it did, the descriptor is built from the bot
    // row. This is the catalog-bypass guard at the runtime boundary.
    const res = await send(USER, {
      content: 'Hello?',
      model: { provider: 'openai', model_id: 'gpt-4-turbo' },
    });

    expect(res.status).toBe(201);
    expect(lastChatPayload().model).toEqual({
      provider: 'openrouter',
      model_id: 'openai/gpt-4o-mini',
    });
  });

  it('reads the bot row once for the model and once for the configuration', async () => {
    arrange({ aiModelId: 'model-1', aiModel: modelRow() });

    await send();

    // Checkpoint 5 added the configuration read, so the message path makes exactly two
    // `bot.findUnique` calls — one for the config projection (`isActive`, model ids) and one
    // for the resolver's nested model select. Still no cache and no third read.
    expect(prismaMock.bot.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('a bot with no model assigned', () => {
  it('sends no model descriptor when the bot has no assignment', async () => {
    arrange({ aiModelId: null, aiModel: null });

    const res = await send();

    expect(res.status).toBe(201);
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
    expect(aiMock.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        bot_id: BOT_ID,
        message: 'Hello?',
      })
    );
    // Checkpoint 5 always sends the resolved configuration. The claim this test has always
    // made is that there is no `model` key: absent, not `undefined` and not `null`, because
    // a `null` would be a different request on the wire.
    expect(Object.keys(lastChatPayload()).sort()).toEqual(['bot_id', 'config', 'message']);
    expect('model' in lastChatPayload()).toBe(false);
  });

  it('is not a failure: no escalation, no fallback', async () => {
    arrange({ aiModelId: null, aiModel: null });

    const res = await send();

    expect(res.body.data.ai.fallback_required).toBe(false);
    expect(res.body.data.ai.reason).toBeUndefined();
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// The short-circuit conditions
// ---------------------------------------------------------------------------------------

describe('an unusable assigned model short-circuits before the AI call', () => {
  const conditions: Array<{ name: string; resolution: unknown }> = [
    { name: 'the model is disabled', resolution: { aiModelId: 'm', aiModel: modelRow({ enabled: false }) } },
    {
      name: 'the provider is disabled',
      resolution: { aiModelId: 'm', aiModel: modelRow({ provider: { slug: 'openrouter', enabled: false } }) },
    },
    { name: 'the model row is missing', resolution: { aiModelId: 'm', aiModel: null } },
  ];

  it.each(conditions)('$name — no provider spend', async ({ resolution }) => {
    arrange(resolution);

    const res = await send();

    // The point of the whole checkpoint: a configuration fault costs nothing.
    expect(aiMock.chat).not.toHaveBeenCalled();
    expect(res.status).toBe(201);
    expect(res.body.data.ai.fallback_required).toBe(true);
    expect(res.body.data.ai.reason).toBe(AI_FAILURE_REASON.MODEL_UNAVAILABLE);
  });

  it.each(conditions)('$name — escalates and still answers the customer', async ({ resolution }) => {
    arrange(resolution);

    const res = await send();

    expect(prismaMock.conversation.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.conversation.update).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID },
      // Checkpoint 5 adds the escalation metadata alongside the status.
      data: expect.objectContaining({ status: 'WAITING_FOR_HUMAN' }),
    });

    // Both messages are persisted: the customer gets a reply, not an error, and the
    // transcript shows what they asked.
    expect(prismaMock.message.create).toHaveBeenCalledTimes(2);
    expect(res.body.data.userMessage.content).toBe('Hello?');
    expect(res.body.data.assistantMessage.content).toBe(MODEL_UNAVAILABLE_MESSAGE);
  });

  it.each(conditions)('$name — discloses no provider or model', async ({ resolution }) => {
    arrange(resolution);

    const res = await send();

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('openrouter');
    expect(body).not.toContain('gpt-4o-mini');
    expect(body).not.toContain('providerModelId');
    // The operator-facing detail names the broken row; it must not reach the client.
    expect(body).not.toContain('is disabled');
    expect(body).not.toContain('row is missing');
  });

  it('a missing bot row is a 404, not a silent fall back to the platform default', async () => {
    arrange(null);

    const res = await send();

    // Checkpoint 5 resolves the configuration before the model, and a configuration cannot
    // be resolved for a bot row that does not exist — so this anomaly is refused rather than
    // served. Serving the platform default would attribute an answer to a model the
    // workspace did not choose; either way the substitution the failure policy prevents is
    // impossible.
    expect(aiMock.chat).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('distinguishes "no model assigned" from "assigned model unusable"', async () => {
    arrange({ aiModelId: null, aiModel: null });
    const cleared = await send();

    vi.clearAllMocks();
    aiMock.chat.mockResolvedValue({ status: 'success', response: 'ok', fallback_required: false });
    arrange({ aiModelId: 'm', aiModel: modelRow({ enabled: false }) });
    const disabled = await send();

    // The two states must never behave the same way: clearing an assignment is a normal,
    // supported configuration; a disabled model is a fault the operator must hear about.
    expect(cleared.body.data.ai.fallback_required).toBe(false);
    expect(disabled.body.data.ai.fallback_required).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Reason propagation from Python
// ---------------------------------------------------------------------------------------

describe('a reason from the AI service', () => {
  it('reaches the client unchanged and escalates', async () => {
    arrange({ aiModelId: 'm', aiModel: modelRow() });
    aiMock.chat.mockResolvedValue({
      status: 'fallback',
      response: 'This assistant is temporarily busy.',
      fallback_required: true,
      reason: AI_FAILURE_REASON.MODEL_RATE_LIMITED,
    });

    const res = await send();

    // Node originates only MODEL_UNAVAILABLE of its own accord; anything else is Python's
    // to report, and Node must not rewrite it.
    expect(res.body.data.ai.reason).toBe(AI_FAILURE_REASON.MODEL_RATE_LIMITED);
    expect(res.body.data.ai.fallback_required).toBe(true);
    expect(prismaMock.conversation.update).toHaveBeenCalledTimes(1);
  });

  it('a MODEL_ERROR from Python escalates the same way as a configuration fault', async () => {
    arrange({ aiModelId: 'm', aiModel: modelRow() });
    aiMock.chat.mockResolvedValue({
      status: 'fallback',
      response: 'This assistant ran into a problem.',
      fallback_required: true,
      reason: AI_FAILURE_REASON.MODEL_ERROR,
    });

    const res = await send();

    // Different cause, identical customer-facing consequence: a human is needed.
    expect(res.body.data.ai.reason).toBe(AI_FAILURE_REASON.MODEL_ERROR);
    expect(prismaMock.conversation.update).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID },
      data: expect.objectContaining({ status: 'WAITING_FOR_HUMAN' }),
    });
  });
});

// ---------------------------------------------------------------------------------------
// No catalog caching
// ---------------------------------------------------------------------------------------

describe('catalog state is read per request', () => {
  it('a disable between two messages takes effect on the next message, with no restart', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });
    prismaMock.workspaceMember.findUnique.mockResolvedValue({
      id: 'member-1',
      userId: USER.id,
      workspaceId: WORKSPACE_ID,
      role: 'OWNER',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID });
    prismaMock.message.create.mockResolvedValue({ id: 'msg', createdAt: new Date() });
    prismaMock.conversation.update.mockResolvedValue({ id: CONVERSATION_ID });

    // Message 1: enabled. Message 2: the same bot, the same model, now disabled — the only
    // difference is what the database returns. The implementation distinguishes the two
    // reads the message path makes per turn (configuration, then model).
    let modelEnabled = true;
    prismaMock.bot.findUnique.mockImplementation(
      async ({ select }: { select?: Record<string, unknown> }) => {
        if (select && 'isActive' in select) {
          return { isActive: true, aiModelId: 'm', fallbackAiModelId: null };
        }
        return {
          aiModelId: 'm',
          fallbackAiModelId: null,
          aiModel: modelRow({ enabled: modelEnabled }),
          fallbackAiModel: null,
        };
      }
    );

    const first = await send();
    modelEnabled = false;
    const second = await send();

    expect(first.body.data.ai.fallback_required).toBe(false);
    expect(second.body.data.ai.fallback_required).toBe(true);
    expect(second.body.data.ai.reason).toBe(AI_FAILURE_REASON.MODEL_UNAVAILABLE);
    expect(aiMock.chat).toHaveBeenCalledTimes(1);

    // Two reads per message (configuration + model), four for two messages: there is no
    // cache, so there is nothing to invalidate.
    expect(prismaMock.bot.findUnique).toHaveBeenCalledTimes(4);
  });

  it('a re-enable is equally immediate', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });
    prismaMock.workspaceMember.findUnique.mockResolvedValue({
      id: 'member-1',
      userId: USER.id,
      workspaceId: WORKSPACE_ID,
      role: 'OWNER',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID });
    prismaMock.message.create.mockResolvedValue({ id: 'msg', createdAt: new Date() });
    prismaMock.conversation.update.mockResolvedValue({ id: CONVERSATION_ID });

    let modelEnabled = false;
    prismaMock.bot.findUnique.mockImplementation(
      async ({ select }: { select?: Record<string, unknown> }) => {
        if (select && 'isActive' in select) {
          return { isActive: true, aiModelId: 'm', fallbackAiModelId: null };
        }
        return {
          aiModelId: 'm',
          fallbackAiModelId: null,
          aiModel: modelRow({ enabled: modelEnabled }),
          fallbackAiModel: null,
        };
      }
    );

    const blocked = await send();
    modelEnabled = true;
    const recovered = await send();

    expect(blocked.body.data.ai.reason).toBe(AI_FAILURE_REASON.MODEL_UNAVAILABLE);
    expect(recovered.body.data.ai.fallback_required).toBe(false);
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------
// Authorization is unchanged by any of this
// ---------------------------------------------------------------------------------------

describe('the resolver does not weaken existing authorization', () => {
  it('a non-member gets 404 and is never told whether the model is usable', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await send(OTHER_USER);

    expect(res.status).toBe(404);
    expect(aiMock.chat).not.toHaveBeenCalled();
    // Nothing about the catalog leaks through the denial: no resolution happened at all.
    expect(prismaMock.bot.findUnique).not.toHaveBeenCalled();
  });
});
