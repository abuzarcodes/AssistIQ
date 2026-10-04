import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/**
 * The fallback model (docs/BOT_IMPLEMENTATION_PLAN.md §10.3, §13.2).
 *
 * Two halves, tested at the level each one actually lives at:
 *
 *  - **Assignment** runs through the real `PATCH /bots/:botId/model` route, because the
 *    rules are split across three layers — `assignModelSchema` catches a body that names
 *    both fields, `assignBotModel` catches the stored pair, and the route applies
 *    authorization. A service-level test would miss the first and a schema test the second.
 *  - **The promotion ladder** is exercised both directly (every rung, exhaustively) and
 *    through the message path (the rung where money is saved). Direct calls make the rungs
 *    that are invisible from outside — "primary usable, fallback unusable" ends in the same
 *    success as "both usable" — assertable at all.
 *
 * `aiMock.chat` is the assertion of record for the end-to-end cases: rung 4's whole purpose
 * is that it is never called, and a response-body assertion alone would pass on a
 * short-circuit that had already spent provider money.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  bot: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  aIModel: { findUnique: vi.fn() },
  conversation: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
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
const { resolveBotModel } = await import('../src/services/botModelResolver.js');
const { MODEL_UNAVAILABLE_MESSAGE, AI_FAILURE_REASON } = await import(
  '../src/constants/aiFailure.js'
);

const OWNER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'owner@example.com' };
const AGENT = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'agent@example.com' };

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333';
const PRIMARY_ID = '44444444-4444-4444-4444-444444444444';
const FALLBACK_ID = '55555555-5555-5555-5555-555555555555';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

// ---------------------------------------------------------------------------------------
// Assignment — PATCH /bots/:botId/model
// ---------------------------------------------------------------------------------------

const membership = (user = OWNER, role: 'OWNER' | 'AGENT' = 'OWNER') =>
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'member-1',
    userId: user.id,
    workspaceId: WORKSPACE_ID,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

/** A bot as `getBotById` returns it — membership-scoped, with both model slots. */
const botRow = (overrides: Record<string, unknown> = {}) => ({
  id: BOT_ID,
  name: 'Helper',
  description: null,
  workspaceId: WORKSPACE_ID,
  aiModelId: null,
  fallbackAiModelId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  aiModel: null,
  fallbackAiModel: null,
  ...overrides,
});

/** A catalog row as `checkModel` selects it. */
const catalogModel = (overrides: Record<string, unknown> = {}) => ({
  id: PRIMARY_ID,
  enabled: true,
  provider: { enabled: true },
  ...overrides,
});

/**
 * Arrange one assignment request.
 *
 * `bot.findUnique` answers the permission middleware's scope resolution; `bot.findFirst`
 * answers `getBotById`. Both are needed, and in that order — leaving the first unprimed
 * makes every request 404 before the handler runs.
 */
const arrange = (stored: Record<string, unknown> = {}) => {
  prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
  membership();
  prismaMock.bot.findFirst.mockResolvedValue(botRow(stored));
  prismaMock.bot.update.mockResolvedValue(botRow(stored));
};

const patchModel = (body: Record<string, unknown>, user = OWNER) =>
  request(app)
    .patch(`/api/v1/bots/${BOT_ID}/model`)
    .set('Authorization', authHeader(user))
    .send(body);

beforeEach(() => {
  vi.resetAllMocks();
  aiMock.chat.mockResolvedValue({
    status: 'success',
    response: 'Mock assistant reply',
    fallback_required: false,
  });
});

describe('PATCH /bots/:botId/model — assigning the fallback', () => {
  it('writes both slots when both are named', async () => {
    arrange();
    prismaMock.aIModel.findUnique.mockResolvedValue(catalogModel());

    const res = await patchModel({ aiModelId: PRIMARY_ID, fallbackAiModelId: FALLBACK_ID });

    expect(res.status).toBe(200);
    expect(prismaMock.bot.update.mock.calls[0][0].data).toEqual({
      aiModelId: PRIMARY_ID,
      fallbackAiModelId: FALLBACK_ID,
    });
  });

  it('writes only the fallback when the primary is not named', async () => {
    arrange({ aiModelId: PRIMARY_ID });
    prismaMock.aIModel.findUnique.mockResolvedValue(catalogModel());

    const res = await patchModel({ fallbackAiModelId: FALLBACK_ID });

    expect(res.status).toBe(200);
    // Spreading both fields would turn "change the fallback" into "also re-assert the
    // primary", clobbering a concurrent change to a field this request never mentioned.
    expect(prismaMock.bot.update.mock.calls[0][0].data).toEqual({
      fallbackAiModelId: FALLBACK_ID,
    });
  });

  it('clears the fallback with an explicit null', async () => {
    arrange({ aiModelId: PRIMARY_ID, fallbackAiModelId: FALLBACK_ID });

    const res = await patchModel({ fallbackAiModelId: null });

    expect(res.status).toBe(200);
    expect(prismaMock.bot.update.mock.calls[0][0].data).toEqual({ fallbackAiModelId: null });
  });

  it('checks an unnamed field against the value the bot actually has', async () => {
    // The bot's stored primary is FALLBACK_ID; the request names only the fallback, as
    // FALLBACK_ID. `assignModelSchema` cannot see this — the two ids never meet in one
    // body — so the service has to compare the effective pair. The named model passes the
    // catalog checks, so the *only* rule left to fail is the pair.
    arrange({ aiModelId: FALLBACK_ID });
    prismaMock.aIModel.findUnique.mockResolvedValue(catalogModel());

    const res = await patchModel({ fallbackAiModelId: FALLBACK_ID });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/must differ/i);
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('rejects a body naming the same model twice (400)', async () => {
    arrange();
    prismaMock.aIModel.findUnique.mockResolvedValue(catalogModel());

    const res = await patchModel({ aiModelId: PRIMARY_ID, fallbackAiModelId: PRIMARY_ID });

    // Caught by the schema, before any database read: the handler never runs.
    expect(res.status).toBe(400);
    expect(prismaMock.aIModel.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('rejects a disabled fallback (400)', async () => {
    arrange();
    prismaMock.aIModel.findUnique.mockResolvedValue(catalogModel({ enabled: false }));

    const res = await patchModel({ fallbackAiModelId: FALLBACK_ID });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not enabled/i);
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('rejects a fallback whose provider is disabled (400)', async () => {
    arrange();
    prismaMock.aIModel.findUnique.mockResolvedValue(
      catalogModel({ provider: { enabled: false } })
    );

    const res = await patchModel({ fallbackAiModelId: FALLBACK_ID });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/provider is not enabled/i);
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown fallback model (400)', async () => {
    arrange();
    prismaMock.aIModel.findUnique.mockResolvedValue(null);

    const res = await patchModel({ fallbackAiModelId: FALLBACK_ID });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unknown model/i);
  });

  it('rejects a non-uuid fallback id before any lookup (400)', async () => {
    arrange();

    const res = await patchModel({ fallbackAiModelId: 'openai/gpt-4o-mini' });

    // A provider-native id is the catalog-bypass attempt; it fails validation, not lookup.
    expect(res.status).toBe(400);
    expect(prismaMock.aIModel.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a body that names neither field (400)', async () => {
    arrange();

    const res = await patchModel({});

    expect(res.status).toBe(400);
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('refuses an AGENT — model assignment is `bots:manage` (403)', async () => {
    prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
    membership(AGENT, 'AGENT');
    prismaMock.bot.findFirst.mockResolvedValue(botRow());

    const res = await patchModel({ fallbackAiModelId: FALLBACK_ID }, AGENT);

    expect(res.status).toBe(403);
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /bots/:botId/model — backward compatibility', () => {
  /**
   * The plan flags the schema change as a risk: extending `assignModelSchema` with a second
   * field must not alter what the *existing* single-field request does. These pin that.
   */
  it('a body naming only `aiModelId` still works, and writes only that field', async () => {
    arrange();
    prismaMock.aIModel.findUnique.mockResolvedValue(catalogModel());

    const res = await patchModel({ aiModelId: PRIMARY_ID });

    expect(res.status).toBe(200);
    expect(prismaMock.bot.update.mock.calls[0][0].data).toEqual({ aiModelId: PRIMARY_ID });
  });

  it('`aiModelId: null` still returns the slot to the platform default', async () => {
    arrange({ aiModelId: PRIMARY_ID });

    const res = await patchModel({ aiModelId: null });

    expect(res.status).toBe(200);
    // The platform default is the absence of an assignment — a supported state, not a
    // failure — and no catalog lookup is needed to reach it.
    expect(prismaMock.aIModel.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.bot.update.mock.calls[0][0].data).toEqual({ aiModelId: null });
  });

  it('`aiModelId: null` does not count as "same as the fallback"', async () => {
    arrange({ fallbackAiModelId: FALLBACK_ID });

    const res = await patchModel({ aiModelId: null });

    // Two nulls are not a duplicate pair — only a concrete model assigned to both slots is.
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------
// The promotion ladder (§13.2) — every rung, directly
// ---------------------------------------------------------------------------------------

/** A catalog row as the resolver's nested select returns it. */
const resolvable = (overrides: Record<string, unknown> = {}) => ({
  providerModelId: 'openai/gpt-4o-mini',
  enabled: true,
  provider: { slug: 'openrouter', enabled: true },
  ...overrides,
});

const resolutionRow = (overrides: Record<string, unknown> = {}) =>
  prismaMock.bot.findUnique.mockResolvedValue({
    aiModelId: PRIMARY_ID,
    fallbackAiModelId: FALLBACK_ID,
    aiModel: resolvable({ providerModelId: 'primary-model' }),
    fallbackAiModel: resolvable({ providerModelId: 'fallback-model', provider: { slug: 'groq', enabled: true } }),
    ...overrides,
  });

describe('resolveBotModel — the ladder', () => {
  it('rung 1: both usable → the primary serves and the fallback is sent along', async () => {
    resolutionRow();

    const resolution = await resolveBotModel(BOT_ID);

    expect(resolution).toEqual({
      ok: true,
      model: { provider: 'openrouter', model_id: 'primary-model' },
      fallbackModel: { provider: 'groq', model_id: 'fallback-model' },
      promoted: false,
    });
  });

  it('rung 2: primary unusable → the fallback serves and `promoted` is true', async () => {
    resolutionRow({ aiModel: resolvable({ enabled: false }) });

    const resolution = await resolveBotModel(BOT_ID);

    expect(resolution).toEqual({
      ok: true,
      model: { provider: 'groq', model_id: 'fallback-model' },
      promoted: true,
    });
  });

  it('rung 2 also fires when the primary model row is missing entirely', async () => {
    resolutionRow({ aiModel: null });

    const resolution = await resolveBotModel(BOT_ID);

    // `aiModelId` is set but the relation reads null — unreachable through the API behind
    // the `Restrict` foreign key, so reaching it is a data anomaly. It must degrade to the
    // fallback rather than throw inside a request that already stored the customer message.
    expect(resolution).toMatchObject({ ok: true, promoted: true });
  });

  it.each([
    ['the primary provider is disabled', { provider: { slug: 'openrouter', enabled: false } }],
    ['the primary model is disabled', { enabled: false }],
  ])('rung 2 fires when %s', async (_label, override) => {
    resolutionRow({ aiModel: resolvable(override) });

    const resolution = await resolveBotModel(BOT_ID);

    expect(resolution).toMatchObject({ ok: true, promoted: true });
  });

  it('rung 3: primary usable, fallback unusable → no `fallbackModel` key at all', async () => {
    resolutionRow({ fallbackAiModel: resolvable({ enabled: false }) });

    const resolution = await resolveBotModel(BOT_ID);

    // Sending an unusable fallback would make Python attempt a retry guaranteed to fail,
    // spending a second timeout on a request that should have escalated immediately.
    expect(resolution).toEqual({
      ok: true,
      model: { provider: 'openrouter', model_id: 'primary-model' },
      promoted: false,
    });
    expect('fallbackModel' in (resolution as object)).toBe(false);
  });

  it('rung 3 is still a success when no fallback is assigned at all', async () => {
    resolutionRow({ fallbackAiModelId: null, fallbackAiModel: null });

    const resolution = await resolveBotModel(BOT_ID);

    // A missing backup is not a fault — never a user-visible error.
    expect(resolution).toEqual({
      ok: true,
      model: { provider: 'openrouter', model_id: 'primary-model' },
      promoted: false,
    });
  });

  it('rung 4: neither usable → not ok, with the platform reason code', async () => {
    resolutionRow({
      aiModel: resolvable({ enabled: false }),
      fallbackAiModel: resolvable({ enabled: false }),
    });

    const resolution = await resolveBotModel(BOT_ID);

    expect(resolution).toMatchObject({ ok: false, reason: AI_FAILURE_REASON.MODEL_UNAVAILABLE });
    // `detail` names both ends so an operator can see which to fix.
    expect((resolution as { detail: string }).detail).toMatch(/primary.*fallback/);
  });

  it('rung 4 reports BOTH causes, not just the first', async () => {
    resolutionRow({
      aiModel: resolvable({ provider: { slug: 'openrouter', enabled: false } }),
      fallbackAiModel: resolvable({ enabled: false }),
    });

    const resolution = await resolveBotModel(BOT_ID);
    const detail = (resolution as { detail: string }).detail;

    expect(detail).toMatch(/provider 'openrouter' is disabled/);
    expect(detail).toMatch(/fallback model is disabled/);
  });

  it('a bot with no primary assignment resolves to the platform default, ignoring the fallback', async () => {
    resolutionRow({ aiModelId: null, aiModel: null });

    const resolution = await resolveBotModel(BOT_ID);

    // There is nothing to fail over *from*, so a configured fallback is irrelevant here.
    expect(resolution).toEqual({ ok: true, promoted: false });
  });

  it('reports failure when the bot row itself cannot be read', async () => {
    prismaMock.bot.findUnique.mockResolvedValue(null);

    const resolution = await resolveBotModel(BOT_ID);

    // Not treated as "no model assigned": silently serving the platform default would
    // attribute an answer to a model the workspace did not choose.
    expect(resolution).toMatchObject({ ok: false, reason: AI_FAILURE_REASON.MODEL_UNAVAILABLE });
  });

  it('reads the whole ladder in a single query', async () => {
    resolutionRow();

    await resolveBotModel(BOT_ID);

    // A hard constraint, not a preference: this runs inside the message-send path.
    expect(prismaMock.bot.findUnique).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------
// The ladder as the customer experiences it
// ---------------------------------------------------------------------------------------

const arrangeMessage = (resolution: Record<string, unknown>) => {
  prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });
  membership();
  prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID });
  // `isActive` answers the configuration read (Checkpoint 5); the rest answers the model
  // resolver. Both select from the same row.
  prismaMock.bot.findUnique.mockResolvedValue({ isActive: true, ...resolution });
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
  prismaMock.conversation.update.mockResolvedValue({
    id: CONVERSATION_ID,
    status: 'WAITING_FOR_HUMAN',
  });
};

const send = () =>
  request(app)
    .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
    .set('Authorization', authHeader(OWNER))
    .send({ content: 'Hello?' });

describe('the promotion ladder seen through the message path', () => {
  it('serves the customer with the fallback when the primary is dead', async () => {
    arrangeMessage({
      aiModelId: PRIMARY_ID,
      fallbackAiModelId: FALLBACK_ID,
      aiModel: resolvable({ enabled: false }),
      fallbackAiModel: resolvable({
        providerModelId: 'fallback-model',
        provider: { slug: 'groq', enabled: true },
      }),
    });

    const res = await send();

    expect(res.status).toBe(201);
    expect(res.body.data.assistantMessage.content).toBe('Mock assistant reply');
    // The provider call carries the *fallback* descriptor — the promotion is real, not just
    // a flag on a resolution object nobody reads.
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
    expect(aiMock.chat.mock.calls[0][0]).toMatchObject({
      bot_id: BOT_ID,
      model: { provider: 'groq', model_id: 'fallback-model' },
    });
  });

  it('serves the customer with the primary when both are usable', async () => {
    arrangeMessage({
      aiModelId: PRIMARY_ID,
      fallbackAiModelId: FALLBACK_ID,
      aiModel: resolvable({ providerModelId: 'primary-model' }),
      fallbackAiModel: resolvable({ providerModelId: 'fallback-model' }),
    });

    await send();

    expect(aiMock.chat.mock.calls[0][0]).toMatchObject({
      model: { provider: 'openrouter', model_id: 'primary-model' },
    });
  });

  it('escalates with the fixed message and spends nothing when neither can serve', async () => {
    arrangeMessage({
      aiModelId: PRIMARY_ID,
      fallbackAiModelId: FALLBACK_ID,
      aiModel: resolvable({ enabled: false }),
      fallbackAiModel: resolvable({ enabled: false }),
    });

    const res = await send();

    expect(res.status).toBe(201);
    expect(res.body.data.ai.reason).toBe(AI_FAILURE_REASON.MODEL_UNAVAILABLE);
    expect(res.body.data.assistantMessage.content).toBe(MODEL_UNAVAILABLE_MESSAGE);
    // The whole point of rung 4: the failure is detected before any provider spend.
    expect(aiMock.chat).not.toHaveBeenCalled();
    // And the customer is never told which model broke — the reason code is the same for
    // every cause.
    expect(JSON.stringify(res.body)).not.toContain('disabled');
  });

  it('a bot with no assignment sends no model or fallback descriptor', async () => {
    arrangeMessage({ aiModelId: null, fallbackAiModelId: null, aiModel: null, fallbackAiModel: null });

    await send();

    // Checkpoint 5 adds the resolved configuration to the payload. The load-bearing claim
    // is unchanged: with no assignment there is no `model` and no `fallback_model` on the
    // wire, so Python takes its environment-configured default.
    const payload = aiMock.chat.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['bot_id', 'config', 'message']);
    expect('model' in payload).toBe(false);
    expect('fallback_model' in payload).toBe(false);
  });
});
