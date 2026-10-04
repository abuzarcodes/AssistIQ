import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/**
 * Checkpoint 6 — the disable-after-assignment lifecycle.
 *
 * This is the plan's central behavioural guarantee: a platform action visibly and correctly
 * changes an in-flight tenant's experience, and reversing the action restores it with no
 * restart and no reassignment. It is written as **one continuous scenario** rather than a
 * set of isolated assertions, because the property being proven is that state carries
 * *across* requests — something no single request-level test can show.
 *
 * The mock holds a mutable catalog rather than a canned sequence of return values. That
 * distinction is the whole test: `PATCH /platform/models/:modelId` really writes to it, and
 * the next chat really reads what the write left behind. A test that queued
 * `mockResolvedValueOnce` per step would pass even if the resolver cached, because it would
 * be asserting on the mock's script rather than on the system's behaviour.
 *
 * The AI service is mocked, so *its* replies are scripted — but only its replies. Whether
 * it is called at all, and with what, is the actual subject.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  workspace: { findFirst: vi.fn() },
  bot: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  aIProvider: { findUnique: vi.fn(), update: vi.fn() },
  aIModel: { findUnique: vi.fn(), update: vi.fn() },
  conversation: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  message: { create: vi.fn() },
  // Checkpoint 5: the message path resolves the bot configuration as well as its model.
  botConfiguration: { findUnique: vi.fn() },
  knowledgeSource: { findMany: vi.fn() },
}));

const aiMock = vi.hoisted(() => ({ chat: vi.fn(), getAiStatus: vi.fn() }));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');
const { MODEL_UNAVAILABLE_MESSAGE, AI_FAILURE_REASON } = await import(
  '../src/constants/aiFailure.js'
);

const OWNER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'owner@example.com' };
const PLATFORM = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', email: 'platform@example.com' };

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const PROVIDER_ID = '44444444-4444-4444-4444-444444444444';
const MODEL_A = '55555555-5555-5555-5555-555555555555';
const MODEL_B = '66666666-6666-6666-6666-666666666666';
const BOT_A = '22222222-2222-2222-2222-222222222222';
const BOT_B = '77777777-7777-7777-7777-777777777777';
const CONV_A = '33333333-3333-3333-3333-333333333333';
const CONV_B = '88888888-8888-8888-8888-888888888888';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

// --- The mutable catalog the mocks read and write --------------------------------------

interface CatalogModel {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  enabled: boolean;
}

const catalog: {
  provider: { id: string; slug: string; name: string; description: string | null; enabled: boolean };
  models: CatalogModel[];
  bots: Array<{ id: string; aiModelId: string | null }>;
} = {
  provider: { id: PROVIDER_ID, slug: 'openrouter', name: 'OpenRouter', description: null, enabled: true },
  models: [
    { id: MODEL_A, providerId: PROVIDER_ID, providerModelId: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini', enabled: true },
    { id: MODEL_B, providerId: PROVIDER_ID, providerModelId: 'anthropic/claude-sonnet-4', displayName: 'Claude Sonnet 4', enabled: true },
  ],
  bots: [
    { id: BOT_A, aiModelId: MODEL_A },
    { id: BOT_B, aiModelId: MODEL_B },
  ],
};

const findModel = (id: string) => catalog.models.find((model) => model.id === id);
const findBot = (id: string) => catalog.bots.find((bot) => bot.id === id);
const botCount = (modelId: string) => catalog.bots.filter((bot) => bot.aiModelId === modelId).length;

/** A catalog model as Prisma's `modelInclude` returns it. */
const modelView = (model: CatalogModel) => ({
  ...model,
  provider: { ...catalog.provider },
  _count: { bots: botCount(model.id) },
});

/** A catalog provider as Prisma's `providerSelect` returns it. */
const providerView = () => ({
  ...catalog.provider,
  models: catalog.models
    .filter((model) => model.providerId === catalog.provider.id)
    .map((model) => ({ enabled: model.enabled })),
});

beforeEach(() => {
  vi.clearAllMocks();

  // Reset the world to the scenario's starting state, so each test is independent.
  catalog.provider.enabled = true;
  catalog.models[0].enabled = true;
  catalog.models[1].enabled = true;
  catalog.bots[0].aiModelId = MODEL_A;
  catalog.bots[1].aiModelId = MODEL_B;

  // --- Authorization ---
  prismaMock.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === PLATFORM.id ? { platformRole: 'PLATFORM_OWNER' } : { platformRole: 'USER' }
  );
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'member-1',
    userId: OWNER.id,
    workspaceId: WORKSPACE_ID,
    role: 'OWNER',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // --- The catalog, read live ---
  prismaMock.aIModel.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const model = findModel(where.id);
    return model ? { id: model.id } : null;
  });
  prismaMock.aIModel.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Partial<CatalogModel> }) => {
      const model = findModel(where.id);
      if (!model) throw new Error('model not found');
      if (data.enabled !== undefined) model.enabled = data.enabled;
      if (data.displayName !== undefined) model.displayName = data.displayName;
      return modelView(model);
    }
  );
  prismaMock.aIProvider.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === catalog.provider.id ? { id: catalog.provider.id } : null
  );
  prismaMock.aIProvider.update.mockImplementation(
    async ({ data }: { data: { name?: string; description?: string | null; enabled?: boolean } }) => {
      if (data.enabled !== undefined) catalog.provider.enabled = data.enabled;
      if (data.name !== undefined) catalog.provider.name = data.name;
      if (data.description !== undefined) catalog.provider.description = data.description;
      return providerView();
    }
  );

  /**
   * `bot.findUnique` is read by two different callers on these routes: the permission
   * middleware asks for `workspaceId`, and the resolver asks for the model. The mock honours
   * `select` rather than handing both a superset of columns — otherwise the test would stop
   * noticing if the resolver ever asked for a field it did not get.
   */
  prismaMock.bot.findUnique.mockImplementation(
    async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
      const bot = findBot(where.id);
      if (!bot) return null;

      // The configuration read (Checkpoint 5) asks for `isActive`; the resolver asks for
      // `aiModelId`. Both are distinguished from the middleware's scope read.
      if (select && 'isActive' in select) {
        return { isActive: true, aiModelId: bot.aiModelId, fallbackAiModelId: null };
      }
      if (select && 'aiModelId' in select) {
        const model = bot.aiModelId ? findModel(bot.aiModelId) : null;
        return {
          aiModelId: bot.aiModelId,
          fallbackAiModelId: null,
          aiModel: model
            ? {
                providerModelId: model.providerModelId,
                enabled: model.enabled,
                provider: { slug: catalog.provider.slug, enabled: catalog.provider.enabled },
              }
            : null,
          fallbackAiModel: null,
        };
      }

      return { workspaceId: WORKSPACE_ID };
    }
  );

  // --- Conversation flow ---
  const conversations: Record<string, string> = { [CONV_A]: BOT_A, [CONV_B]: BOT_B };
  prismaMock.conversation.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    conversations[where.id] ? { bot: { workspaceId: WORKSPACE_ID } } : null
  );
  prismaMock.conversation.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) =>
    conversations[where.id] ? { id: where.id, botId: conversations[where.id] } : null
  );
  prismaMock.conversation.update.mockResolvedValue({ id: CONV_A, status: 'WAITING_FOR_HUMAN' });

  prismaMock.bot.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const bot = findBot(where.id);
    return bot ? { id: bot.id, name: 'Helper', description: null, workspaceId: WORKSPACE_ID, aiModelId: bot.aiModelId } : null;
  });
  prismaMock.bot.update.mockImplementation(async ({ where, data }: { where: { id: string }; data: { aiModelId: string | null } }) => {
    const bot = findBot(where.id);
    if (!bot) throw new Error('bot not found');
    bot.aiModelId = data.aiModelId;
    return { ...bot, aiModel: bot.aiModelId ? modelView(findModel(bot.aiModelId)!) : null };
  });

  prismaMock.message.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: args.data.role === 'USER' ? 'msg-user' : 'msg-assistant',
    conversationId: args.data.conversationId,
    role: args.data.role,
    content: args.data.content,
    createdAt: new Date(),
  }));
  // Checkpoint 5: no configuration row → defaults (fallback enabled, no business hours).
  prismaMock.botConfiguration.findUnique.mockResolvedValue(null);

  // --- The AI boundary ---
  aiMock.chat.mockResolvedValue({
    status: 'success',
    response: 'Mock assistant reply',
    fallback_required: false,
  });
  aiMock.getAiStatus.mockResolvedValue({ provider_adapters: [{ slug: 'openrouter', configured: true }] });
});

// --- The three verbs the scenario is built from -----------------------------------------

const chatOn = (conversationId: string) =>
  request(app)
    .post(`/api/v1/conversations/${conversationId}/messages`)
    .set('Authorization', authHeader(OWNER))
    .send({ content: 'What are your hours?' });

const setModelEnabled = (modelId: string, enabled: boolean) =>
  request(app)
    .patch(`/api/v1/platform/models/${modelId}`)
    .set('Authorization', authHeader(PLATFORM))
    .send({ enabled });

const setProviderEnabled = (enabled: boolean) =>
  request(app)
    .patch(`/api/v1/platform/providers/${PROVIDER_ID}`)
    .set('Authorization', authHeader(PLATFORM))
    .send({ enabled });

const clearBotModel = (botId: string) =>
  request(app)
    .patch(`/api/v1/bots/${botId}/model`)
    .set('Authorization', authHeader(OWNER))
    .send({ aiModelId: null });

const lastChatPayload = () => aiMock.chat.mock.calls.at(-1)?.[0] as Record<string, unknown>;

// ---------------------------------------------------------------------------------------
// The integration scenario
// ---------------------------------------------------------------------------------------

describe('disable-after-assignment: the full lifecycle', () => {
  it('succeeds, breaks visibly, and recovers — with no restart and no reassignment', async () => {
    // --- Step 1: chat succeeds on the assigned model ---
    const before = await chatOn(CONV_A);

    expect(before.status).toBe(201);
    expect(before.body.data.ai.fallback_required).toBe(false);
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
    expect(lastChatPayload().model).toEqual({
      provider: 'openrouter',
      model_id: 'openai/gpt-4o-mini',
    });
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();

    // --- Step 2: the platform owner disables the model ---
    const disabled = await setModelEnabled(MODEL_A, false);

    expect(disabled.status).toBe(200);
    // The write is real: the stored row changed, not merely the response.
    expect(findModel(MODEL_A)!.enabled).toBe(false);
    expect(findModel(MODEL_B)!.enabled).toBe(true);

    // --- Step 3: the next message on the same bot takes the short-circuit path ---
    const blocked = await chatOn(CONV_A);

    expect(blocked.status).toBe(201);
    // Not called *again* — the disabled model consumed no provider spend.
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
    expect(blocked.body.data.ai.fallback_required).toBe(true);
    expect(blocked.body.data.ai.reason).toBe(AI_FAILURE_REASON.MODEL_UNAVAILABLE);

    // The escalation shape: exactly one update, carrying the status and the Checkpoint 5
    // escalation metadata (reason, time, off-hours flag).
    expect(prismaMock.conversation.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.conversation.update).toHaveBeenCalledWith({
      where: { id: CONV_A },
      data: expect.objectContaining({ status: 'WAITING_FOR_HUMAN' }),
    });

    // The customer sees a reply, not an error, and their question is in the transcript.
    expect(blocked.body.data.userMessage.content).toBe('What are your hours?');
    expect(blocked.body.data.assistantMessage.content).toBe(MODEL_UNAVAILABLE_MESSAGE);
    const body = JSON.stringify(blocked.body);
    expect(body).not.toContain('openrouter');
    expect(body).not.toContain('gpt-4o-mini');

    // --- Step 4: the platform owner re-enables the model ---
    const reenabled = await setModelEnabled(MODEL_A, true);
    expect(reenabled.status).toBe(200);
    expect(findModel(MODEL_A)!.enabled).toBe(true);

    // --- Step 5: chat recovers, without a restart or a reassignment ---
    const recovered = await chatOn(CONV_A);

    expect(recovered.status).toBe(201);
    expect(recovered.body.data.ai.fallback_required).toBe(false);
    expect(aiMock.chat).toHaveBeenCalledTimes(2);
    expect(lastChatPayload().model).toEqual({
      provider: 'openrouter',
      model_id: 'openai/gpt-4o-mini',
    });
    // No reassignment happened anywhere in this scenario.
    expect(findBot(BOT_A)!.aiModelId).toBe(MODEL_A);
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('a second bot on a different model is unaffected throughout', async () => {
    await setModelEnabled(MODEL_A, false);

    const blocked = await chatOn(CONV_A);
    const unaffected = await chatOn(CONV_B);

    // The disable is scoped to one model, not a global kill switch.
    expect(blocked.body.data.ai.fallback_required).toBe(true);
    expect(unaffected.body.data.ai.fallback_required).toBe(false);
    expect(lastChatPayload().model).toEqual({
      provider: 'openrouter',
      model_id: 'anthropic/claude-sonnet-4',
    });
    expect(prismaMock.conversation.update).toHaveBeenCalledTimes(1);
  });

  it('disabling the provider has identical outcomes to disabling the model', async () => {
    const disabled = await setProviderEnabled(false);
    expect(disabled.status).toBe(200);

    const blocked = await chatOn(CONV_A);
    expect(blocked.body.data.ai.fallback_required).toBe(true);
    expect(blocked.body.data.ai.reason).toBe(AI_FAILURE_REASON.MODEL_UNAVAILABLE);
    expect(aiMock.chat).not.toHaveBeenCalled();

    // R4: a provider-wide disable mutates zero AIModel rows, which is why re-enabling
    // restores exactly the previous per-model selection.
    expect(catalog.models.every((model) => model.enabled)).toBe(true);

    await setProviderEnabled(true);
    const recovered = await chatOn(CONV_A);
    expect(recovered.body.data.ai.fallback_required).toBe(false);
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
  });

  it('clearing the assignment is the normal default path, not a failure', async () => {
    const cleared = await clearBotModel(BOT_A);
    expect(cleared.status).toBe(200);
    expect(findBot(BOT_A)!.aiModelId).toBeNull();

    const res = await chatOn(CONV_A);

    // This is the distinction the whole failure policy rests on. A cleared assignment is a
    // supported end state; a disabled model is a fault. They must not look alike.
    expect(res.body.data.ai.fallback_required).toBe(false);
    expect(res.body.data.ai.reason).toBeUndefined();
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
    // Checkpoint 5 adds the resolved configuration to every payload; `model` is still absent
    // because this bot has no assignment.
    expect(Object.keys(lastChatPayload()).sort()).toEqual(['bot_id', 'config', 'message']);
    expect('model' in lastChatPayload()).toBe(false);
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
  });

  it('a model re-enabled after a clear still requires a new assignment to take effect', async () => {
    await clearBotModel(BOT_A);
    await setModelEnabled(MODEL_A, false);
    await setModelEnabled(MODEL_A, true);

    const res = await chatOn(CONV_A);

    // Clearing is not a pause: the bot stays on the platform default until someone assigns
    // a model to it again. Catalog state alone cannot re-point a bot.
    expect(res.body.data.ai.fallback_required).toBe(false);
    expect(findBot(BOT_A)!.aiModelId).toBeNull();
  });
});
