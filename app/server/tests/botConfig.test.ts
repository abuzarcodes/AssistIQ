import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/**
 * Checkpoint 1 — configuration resolution, defaults, and validation.
 *
 * These are **service-level** tests: Checkpoint 1 lands the data model, the defaults and
 * the resolution service, and deliberately adds no routes. The route-level assertions
 * (status codes, authorization, avatar) belong to Checkpoint 2 and are the second half of
 * this file.
 *
 * The property under test throughout is the one that makes the rollout safe: **a bot with
 * no `BotConfiguration` row must behave exactly as it did before this feature existed.**
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  bot: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
  botConfiguration: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  knowledgeChunk: { count: vi.fn() },
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');
const { getBotConfigResponse, updateBotConfig, computeEffective, toPythonConfig, resolveBotConfigForChat } =
  await import('../src/services/botConfig.service.js');
const { resolvedBotConfigSchema, updateBotConfigSchema } = await import('../src/schemas/botConfig.schema.js');
const { BOT_CONFIG_DEFAULTS } = await import('../src/constants/botDefaults.js');
const { resolveCapabilities } = await import('../src/constants/modelCapabilities.js');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';

const authHeader = (userId = USER_ID): string =>
  `Bearer ${signToken({ sub: userId, email: 'owner@example.com' })}`;

/** The bot row as `getBotById` returns it — the membership gate. */
const accessibleBot = () =>
  prismaMock.bot.findFirst.mockResolvedValue({
    id: BOT_ID,
    name: 'Helper',
    description: null,
    workspaceId: WORKSPACE_ID,
    aiModelId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    aiModel: null,
  });

/** The detail read `readBotConfig` performs after the gate. */
const botDetail = (overrides: Record<string, unknown> = {}) =>
  prismaMock.bot.findUniqueOrThrow.mockResolvedValue({
    isActive: true,
    aiModelId: null,
    fallbackAiModelId: null,
    aiModel: null,
    fallbackAiModel: null,
    ...overrides,
  });

const noConfigRow = () => prismaMock.botConfiguration.findUnique.mockResolvedValue(null);

/** A stored `BotConfiguration` row, defaulted and then overridden. */
const configRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'cfg-1',
  botId: BOT_ID,
  version: 1,
  avatarVersion: 0,
  avatarData: null,
  avatarMimeType: null,
  avatarUpdatedAt: null,
  ...BOT_CONFIG_DEFAULTS,
  suggestedQuestions: [...BOT_CONFIG_DEFAULTS.suggestedQuestions],
  thinkingMessages: [...BOT_CONFIG_DEFAULTS.thinkingMessages],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const geminiModel = () => ({
  enabled: true,
  capabilities: null,
  provider: { slug: 'gemini', enabled: true },
});

beforeEach(() => {
  // `resetAllMocks`, not `clearAllMocks`: a persistent `mockResolvedValue` set in one test
  // would otherwise leak into the next and make the suite order-dependent.
  vi.resetAllMocks();
  prismaMock.knowledgeChunk.count.mockResolvedValue(0);
});

describe('defaults — a bot with no configuration row', () => {
  it('resolves to the documented defaults (the no-backfill guarantee)', async () => {
    accessibleBot();
    botDetail();
    noConfigRow();

    const { config, version } = await getBotConfigResponse(BOT_ID, USER_ID);

    expect(version).toBe(0);
    expect(config.personality.preset).toBe('PROFESSIONAL');
    expect(config.personality.tone).toBe('NEUTRAL');
    expect(config.personality.responseLanguage).toBe('AUTO');
    expect(config.personality.responseLength).toBe('BALANCED');
    expect(config.knowledge.enabled).toBe(true);
    expect(config.knowledge.strictness).toBe('BALANCED');
    expect(config.knowledge.showSources).toBe(false);
    expect(config.knowledge.topK).toBe(3);
    // The two values that reproduce the old hard-coded pipeline exactly.
    expect(config.generation.temperature).toBe(0.0);
    expect(config.generation.maxOutputTokens).toBeNull();
    expect(config.generation.topP).toBeNull();
    expect(config.humanSupport.fallbackEnabled).toBe(true);
    expect(config.humanSupport.fallbackMessage).toBeNull();
    expect(config.conversation.suggestedQuestions).toEqual([]);
    expect(config.conversation.feedbackEnabled).toBe(false);
    expect(config.general.isActive).toBe(true);
  });

  it('exposes every documented default in one object for the API and the schema to share', () => {
    // If this drifts from the plan's §8.2 table, that table is wrong — not this test.
    expect(BOT_CONFIG_DEFAULTS.retrievalTopK).toBe(3);
    expect(BOT_CONFIG_DEFAULTS.temperature).toBe(0.0);
    expect(BOT_CONFIG_DEFAULTS.knowledgeStrictness).toBe('BALANCED');
    expect(BOT_CONFIG_DEFAULTS.humanRequestBehavior).toBe('TRANSFER_AUTOMATICALLY');
  });

  it('reports knowledge as inactive when the bot has no enabled chunks', async () => {
    accessibleBot();
    botDetail();
    noConfigRow();
    prismaMock.knowledgeChunk.count.mockResolvedValue(0);

    const { effective } = await getBotConfigResponse(BOT_ID, USER_ID);

    // Knowledge is *switched on* but this bot has nothing to retrieve — which is the fact
    // that explains why answers still fall back on a freshly created bot (§15.1).
    expect(effective.knowledgeActive).toBe(false);
  });

  it('reports knowledge as active when enabled chunks exist', async () => {
    accessibleBot();
    botDetail();
    noConfigRow();
    prismaMock.knowledgeChunk.count.mockResolvedValue(4);

    const { effective } = await getBotConfigResponse(BOT_ID, USER_ID);

    expect(effective.knowledgeActive).toBe(true);
  });

  it('denies a bot the caller is not a member of with 404, before any config read', async () => {
    prismaMock.bot.findFirst.mockResolvedValue(null); // getBotById's scoped query finds nothing

    await expect(getBotConfigResponse(BOT_ID, USER_ID)).rejects.toMatchObject({ statusCode: 404 });
    // The 404 must come from the gate, not from an empty configuration.
    expect(prismaMock.botConfiguration.findUnique).not.toHaveBeenCalled();
  });
});

describe('stored values override defaults', () => {
  it('merges a stored row over the defaults, keeping untouched fields at their default', async () => {
    accessibleBot();
    botDetail();
    prismaMock.botConfiguration.findUnique.mockResolvedValue({
      id: 'cfg-1',
      botId: BOT_ID,
      displayName: 'Ava',
      avatarVersion: 3,
      avatarData: Buffer.from('x'),
      personality: 'FRIENDLY',
      tone: 'EMPATHETIC',
      customPersonality: null,
      customInstructions: 'Always mention the 30-day return window.',
      responseLanguage: 'de',
      responseLength: 'SHORT',
      welcomeMessage: 'Hi there!',
      conversationStarter: null,
      suggestedQuestions: ['Where is my order?', 'How do refunds work?'],
      inputPlaceholder: null,
      thinkingMessages: ['Checking…'],
      feedbackEnabled: true,
      feedbackCollectReason: true,
      knowledgeEnabled: true,
      knowledgeStrictness: 'STRICT',
      showSources: true,
      retrievalTopK: 8,
      temperature: 0.4,
      topP: 0.9,
      frequencyPenalty: null,
      presencePenalty: null,
      maxOutputTokens: 512,
      humanFallbackEnabled: false,
      fallbackMessage: 'Sorry, I do not know that one.',
      humanRequestBehavior: 'CONTINUE_WITH_AI',
      handoffMessage: null,
      businessHours: null,
      contactCollection: null,
      version: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { config, version } = await getBotConfigResponse(BOT_ID, USER_ID);

    // Overridden
    expect(config.personality.preset).toBe('FRIENDLY');
    expect(config.conversation.suggestedQuestions).toEqual([
      'Where is my order?',
      'How do refunds work?',
    ]);
    expect(config.knowledge.strictness).toBe('STRICT');
    expect(config.generation.topP).toBe(0.9);
    expect(config.general.hasAvatar).toBe(true);
    expect(config.general.avatarVersion).toBe(3);
    expect(version).toBe(7);
    // Untouched fields still carry their default rather than going undefined.
    expect(config.generation.frequencyPenalty).toBeNull();
    expect(config.conversation.inputPlaceholder).toBeNull();
    expect(config.humanSupport.handoffMessage).toBeNull();
  });
});

describe('computeEffective — capability filtering (§12.3)', () => {
  const base = {
    general: { isActive: true, displayName: null, hasAvatar: false, avatarVersion: 0 },
    personality: {
      preset: 'PROFESSIONAL' as const,
      tone: 'NEUTRAL' as const,
      customPersonality: null,
      customInstructions: null,
      responseLanguage: 'AUTO',
      responseLength: 'BALANCED' as const,
    },
    conversation: {
      welcomeMessage: null,
      conversationStarter: null,
      suggestedQuestions: [],
      inputPlaceholder: null,
      thinkingMessages: [],
      feedbackEnabled: false,
      feedbackCollectReason: true,
    },
    knowledge: { enabled: true, strictness: 'BALANCED' as const, showSources: false, topK: 3 },
    generation: {
      temperature: 0.5,
      topP: 0.8,
      frequencyPenalty: 0.3,
      presencePenalty: 0.2,
      maxOutputTokens: 256,
    },
    model: { aiModelId: null, fallbackAiModelId: null },
    humanSupport: {
      fallbackEnabled: true,
      fallbackMessage: null,
      humanRequestBehavior: 'TRANSFER_AUTOMATICALLY' as const,
      handoffMessage: null,
      businessHours: null,
      contactCollection: null,
    },
  };

  it('applies every parameter a fully capable model supports', () => {
    const caps = resolveCapabilities({ capabilities: null, provider: { slug: 'openai' } });
    const effective = computeEffective(base, { primary: { usable: true, capabilities: caps }, fallback: null });

    expect(effective.appliedParams).toEqual({
      temperature: 0.5,
      topP: 0.8,
      frequencyPenalty: 0.3,
      presencePenalty: 0.2,
      maxTokens: 256,
    });
    expect(effective.ignoredParams).toEqual([]);
  });

  it('reports penalties as ignored for Gemini rather than rejecting or clearing them', () => {
    const caps = resolveCapabilities({ capabilities: null, provider: { slug: 'gemini' } });
    const effective = computeEffective(base, { primary: { usable: true, capabilities: caps }, fallback: null });

    expect(effective.ignoredParams).toEqual(['frequencyPenalty', 'presencePenalty']);
    expect(effective.appliedParams).toEqual({ temperature: 0.5, topP: 0.8, maxTokens: 256 });
    // The stored intent is untouched — a model swap restores it (§12.3).
    expect(base.generation.frequencyPenalty).toBe(0.3);
  });

  it('honours a per-model capability override over the provider default', () => {
    const caps = resolveCapabilities({
      capabilities: { temperature: false },
      provider: { slug: 'openai' },
    });

    expect(caps.temperature).toBe(false);
    expect(caps.topP).toBe(true); // inherited from the provider default
  });

  it('falls back to the responseLength preset when no explicit token cap is set', () => {
    const caps = resolveCapabilities({ capabilities: null, provider: { slug: 'openai' } });
    const short = { ...base, personality: { ...base.personality, responseLength: 'SHORT' as const }, generation: { ...base.generation, maxOutputTokens: null } };

    const effective = computeEffective(short, { primary: { usable: true, capabilities: caps }, fallback: null });

    expect(effective.appliedParams.maxTokens).toBe(256);
  });

  it('sends no token cap at all for BALANCED with no explicit cap (today’s behaviour)', () => {
    const caps = resolveCapabilities({ capabilities: null, provider: { slug: 'openai' } });
    const balanced = { ...base, generation: { ...base.generation, maxOutputTokens: null } };

    const effective = computeEffective(balanced, { primary: { usable: true, capabilities: caps }, fallback: null });

    expect(effective.appliedParams.maxTokens).toBeUndefined();
    expect(effective.ignoredParams).toEqual([]);
  });

  it('uses the fallback model’s capabilities when the primary is unusable', () => {
    const openai = resolveCapabilities({ capabilities: null, provider: { slug: 'openai' } });
    const gemini = resolveCapabilities({ capabilities: null, provider: { slug: 'gemini' } });

    const effective = computeEffective(base, {
      primary: { usable: false, capabilities: openai },
      fallback: { usable: true, capabilities: gemini },
    });

    // The serving model is Gemini, so its capabilities govern — and the promotion is flagged.
    expect(effective.ignoredParams).toEqual(['frequencyPenalty', 'presencePenalty']);
    expect(effective.modelPromoted).toBe(true);
    expect(effective.modelUnavailable).toBe(false);
  });

  it('reports the model as unavailable when neither model is usable', () => {
    const caps = resolveCapabilities({ capabilities: null, provider: { slug: 'openai' } });
    const effective = computeEffective(base, {
      primary: { usable: false, capabilities: caps },
      fallback: { usable: false, capabilities: caps },
    });

    expect(effective.modelUnavailable).toBe(true);
    expect(effective.modelPromoted).toBe(false);
  });
});

describe('validation (§19)', () => {
  const valid = {
    displayName: null,
    personality: 'PROFESSIONAL' as const,
    tone: 'NEUTRAL' as const,
    customPersonality: null,
    customInstructions: null,
    responseLanguage: 'AUTO',
    responseLength: 'BALANCED' as const,
    welcomeMessage: null,
    conversationStarter: null,
    suggestedQuestions: [],
    inputPlaceholder: null,
    thinkingMessages: [],
    feedbackEnabled: false,
    feedbackCollectReason: true,
    knowledgeEnabled: true,
    knowledgeStrictness: 'BALANCED' as const,
    showSources: false,
    retrievalTopK: 3,
    temperature: 0,
    topP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    maxOutputTokens: null,
    humanFallbackEnabled: true,
    fallbackMessage: null,
    humanRequestBehavior: 'TRANSFER_AUTOMATICALLY' as const,
    handoffMessage: null,
    businessHours: null,
    contactCollection: null,
  };

  it('rejects the reserved sentinel in owner instructions', () => {
    const result = resolvedBotConfigSchema.safeParse({
      ...valid,
      customInstructions: 'If you do not know, say INSUFFICIENT_INFORMATION.',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('INSUFFICIENT_INFORMATION');
  });

  it('rejects CUSTOM personality with no description', () => {
    const result = resolvedBotConfigSchema.safeParse({ ...valid, personality: 'CUSTOM' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes('customPersonality'))).toBe(true);
  });

  it('accepts CUSTOM personality with a description', () => {
    const result = resolvedBotConfigSchema.safeParse({
      ...valid,
      personality: 'CUSTOM',
      customPersonality: 'Like a seasoned barista.',
    });

    expect(result.success).toBe(true);
  });

  it('rejects showing sources while knowledge is disabled', () => {
    const result = resolvedBotConfigSchema.safeParse({
      ...valid,
      knowledgeEnabled: false,
      showSources: true,
    });

    expect(result.success).toBe(false);
  });

  it('rejects a business-hours window that ends before it starts', () => {
    const result = resolvedBotConfigSchema.safeParse({
      ...valid,
      businessHours: {
        timezone: 'Europe/Berlin',
        windows: [{ day: 'MON', start: '17:00', end: '09:00' }],
        afterHoursBehavior: 'MESSAGE_ONLY',
        afterHoursMessage: null,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects two windows on the same day', () => {
    const result = resolvedBotConfigSchema.safeParse({
      ...valid,
      businessHours: {
        timezone: 'Europe/Berlin',
        windows: [
          { day: 'MON', start: '09:00', end: '12:00' },
          { day: 'MON', start: '13:00', end: '17:00' },
        ],
        afterHoursBehavior: 'MESSAGE_ONLY',
        afterHoursMessage: null,
      },
    });

    expect(result.success).toBe(false);
  });

  it('rejects a required contact field that is not collected', () => {
    const result = resolvedBotConfigSchema.safeParse({
      ...valid,
      contactCollection: { enabled: true, fields: ['email'], required: ['phone'] },
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate suggested questions', () => {
    const result = resolvedBotConfigSchema.safeParse({
      ...valid,
      suggestedQuestions: ['Where is my order?', 'where is my order?'],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a temperature outside 0–2', () => {
    expect(resolvedBotConfigSchema.safeParse({ ...valid, temperature: 2.5 }).success).toBe(false);
  });

  it('requires expectedVersion on a PATCH and rejects an empty body', () => {
    expect(updateBotConfigSchema.safeParse({}).success).toBe(false);
    expect(updateBotConfigSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(updateBotConfigSchema.safeParse({ expectedVersion: 1, temperature: 0.3 }).success).toBe(true);
  });
});

describe('updateBotConfig', () => {
  it('merges a patch, increments the version, and returns the full config', async () => {
    accessibleBot();
    botDetail();
    prismaMock.botConfiguration.upsert.mockResolvedValue({});

    // Two reads, in order: the version check (which is also the merge base) and the
    // post-write response.
    prismaMock.botConfiguration.findUnique
      .mockResolvedValueOnce(configRow({ version: 3 }))
      .mockResolvedValueOnce(configRow({ version: 4, temperature: 0.9 }));

    const result = await updateBotConfig(BOT_ID, USER_ID, {
      expectedVersion: 3,
      temperature: 0.9,
    } as never);

    const upsertArgs = prismaMock.botConfiguration.upsert.mock.calls[0]?.[0];
    expect(upsertArgs.update.version).toEqual({ increment: 1 });
    expect(upsertArgs.update.temperature).toBe(0.9);
    // The patch is a *merge*: fields it did not mention keep their stored value.
    expect(upsertArgs.update.personality).toBe('PROFESSIONAL');
    expect(result.config.generation.temperature).toBe(0.9);
  });

  it('rejects a stale expectedVersion with 409 and the current state', async () => {
    accessibleBot();
    botDetail();
    // Stored is version 5; the client believes it is 2.
    prismaMock.botConfiguration.findUnique.mockResolvedValue(configRow({ version: 5 }));

    await expect(
      updateBotConfig(BOT_ID, USER_ID, { expectedVersion: 2, temperature: 0.9 } as never)
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(prismaMock.botConfiguration.upsert).not.toHaveBeenCalled();
  });

  it('forces showSources off when the same patch disables knowledge', async () => {
    accessibleBot();
    botDetail();
    prismaMock.botConfiguration.findUnique.mockResolvedValue(null);
    prismaMock.botConfiguration.upsert.mockResolvedValue({});

    await updateBotConfig(BOT_ID, USER_ID, {
      expectedVersion: 0,
      knowledgeEnabled: false,
      showSources: true,
    } as never);

    const upsertArgs = prismaMock.botConfiguration.upsert.mock.calls[0]?.[0];
    expect(upsertArgs.create.showSources).toBe(false);
  });
});

describe('toPythonConfig — the AI-service projection (§11.1)', () => {
  it('emits only the fields the AI service understands, in snake_case', async () => {
    accessibleBot();
    botDetail();
    noConfigRow();

    const { config } = await getBotConfigResponse(BOT_ID, USER_ID);
    const payload = toPythonConfig(config);

    expect(Object.keys(payload).sort()).toEqual(
      [
        'custom_instructions',
        'custom_personality',
        'fallback',
        'knowledge',
        'params',
        'personality',
        'response_language',
        'response_length',
        'tone',
      ].sort()
    );
    expect(payload.knowledge).toEqual({
      enabled: true,
      strictness: 'BALANCED',
      show_sources: false,
      top_k: 3,
    });
    // Product behaviour must not cross this boundary.
    expect(payload).not.toHaveProperty('welcomeMessage');
    expect(payload).not.toHaveProperty('businessHours');
    expect(payload).not.toHaveProperty('suggestedQuestions');
  });
});

describe('resolveBotConfigForChat', () => {
  it('resolves without the membership gate, for the message-send path', async () => {
    prismaMock.bot.findUnique.mockResolvedValue({
      isActive: true,
      aiModelId: null,
      fallbackAiModelId: null,
    });
    noConfigRow();

    const config = await resolveBotConfigForChat(BOT_ID);

    expect(config.generation.temperature).toBe(0.0);
    expect(prismaMock.bot.findFirst).not.toHaveBeenCalled();
  });

  it('throws 404 when the bot does not exist', async () => {
    prismaMock.bot.findUnique.mockResolvedValue(null);

    await expect(resolveBotConfigForChat(BOT_ID)).rejects.toMatchObject({ statusCode: 404 });
  });
});

// =======================================================================================
// Checkpoint 2 — the HTTP surface
// =======================================================================================
//
// The service tests above call the service directly, which cannot prove a status code, that
// a guard ran before the handler, or that the 409 body carries the *current* configuration.
// These run through the real route table with only the database mocked, so those are
// asserted where they actually happen.

/**
 * Arrange one config request.
 *
 * Three reads are needed and the order is the point: `bot.findUnique` resolves the path's
 * `:botId` to a workspace in the permission middleware, `workspaceMember.findUnique` decides
 * the role, and `bot.findFirst` is `getBotById`'s membership-scoped gate. Leaving the first
 * unprimed makes every request 404 before the handler runs.
 */
const arrangeRoute = (role: 'OWNER' | 'ADMIN' | 'AGENT' = 'OWNER') => {
  prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'member-1',
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  accessibleBot();
};

const getConfig = (userId = USER_ID) =>
  request(app).get(`/api/v1/bots/${BOT_ID}/config`).set('Authorization', authHeader(userId));

const patchConfig = (body: Record<string, unknown>, userId = USER_ID) =>
  request(app)
    .patch(`/api/v1/bots/${BOT_ID}/config`)
    .set('Authorization', authHeader(userId))
    .send(body);

describe('GET /bots/:botId/config', () => {
  it('returns defaults for a bot that has never been configured (200)', async () => {
    arrangeRoute();
    botDetail();
    noConfigRow();

    const res = await getConfig();

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(0);
    expect(res.body.data.updatedAt).toBeNull();
    expect(res.body.data.config.generation.temperature).toBe(0.0);
  });

  it('is a read: `bots:view` suffices, and no new permission string is introduced', async () => {
    arrangeRoute('ADMIN');
    botDetail();
    noConfigRow();

    // ADMIN holds `bots:view` but is not the owner — the read must not be owner-only.
    expect((await getConfig()).status).toBe(200);
  });

  it('is 403 for an AGENT — the configuration surface is OWNER/ADMIN (plan §10.4)', async () => {
    arrangeRoute('AGENT');

    const res = await getConfig();

    // AGENT holds neither `bots:view` nor `bots:manage`.
    expect(res.status).toBe(403);
    expect(prismaMock.bot.findFirst).not.toHaveBeenCalled();
  });

  it('is 401 without a token', async () => {
    const res = await request(app).get(`/api/v1/bots/${BOT_ID}/config`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /bots/:botId/config — optimistic concurrency (§16.2)', () => {
  it('returns 409 carrying the CURRENT configuration when `expectedVersion` is stale', async () => {
    arrangeRoute();
    botDetail();
    // The stored row is at version 5; the client believes it is at 3.
    prismaMock.botConfiguration.findUnique.mockResolvedValue(configRow({ version: 5 }));

    const res = await patchConfig({ welcomeMessage: 'Hi', expectedVersion: 3 });

    expect(res.status).toBe(409);
    // The current state rides along so the client can offer "reload" or "keep mine" without
    // a second round trip — never a silent overwrite of someone else's save.
    expect(res.body.data.version).toBe(5);
    expect(res.body.data.config).toBeDefined();
    expect(prismaMock.botConfiguration.upsert).not.toHaveBeenCalled();
  });

  it('accepts a matching `expectedVersion` and increments it', async () => {
    arrangeRoute();
    botDetail();
    // Two reads: the first is the concurrency check (version 5), the second is the
    // read-back after the write (version 6). The response is built from the *stored* row,
    // so it has to show the incremented version rather than the one the client sent.
    prismaMock.botConfiguration.findUnique
      .mockResolvedValueOnce(configRow({ version: 5 }))
      .mockResolvedValueOnce(configRow({ version: 6 }));
    prismaMock.botConfiguration.upsert.mockResolvedValue(configRow({ version: 6 }));

    const res = await patchConfig({ welcomeMessage: 'Hi there', expectedVersion: 5 });

    expect(res.status).toBe(200);
    expect(prismaMock.botConfiguration.upsert.mock.calls[0][0].update.version).toEqual({
      increment: 1,
    });
    expect(res.body.data.version).toBe(6);
  });

  it('requires `expectedVersion` — a caller cannot omit the concurrency token (400)', async () => {
    arrangeRoute();
    botDetail();
    noConfigRow();

    const res = await patchConfig({ welcomeMessage: 'Hi' });

    expect(res.status).toBe(400);
    expect(prismaMock.botConfiguration.upsert).not.toHaveBeenCalled();
  });

  it('rejects an empty body (400)', async () => {
    arrangeRoute();
    botDetail();
    noConfigRow();

    const res = await patchConfig({ expectedVersion: 0 });

    expect(res.status).toBe(400);
  });

  it('is 403 for an AGENT, before anything is read', async () => {
    arrangeRoute('AGENT');

    const res = await patchConfig({ welcomeMessage: 'Hi', expectedVersion: 0 });

    expect(res.status).toBe(403);
    expect(prismaMock.botConfiguration.findUnique).not.toHaveBeenCalled();
  });
});

describe('GET /bots/:botId/config — `effective` (§12.3)', () => {
  it('reports the penalties as IGNORED for a Gemini model rather than applying them', async () => {
    arrangeRoute();
    // Gemini has no OpenAI-style frequency/presence penalty. The owner's values are stored
    // and still shown in the form — they are simply not sent to the provider, and
    // `ignoredParams` is the only signal that says so.
    botDetail({
      aiModelId: '66666666-6666-6666-6666-666666666666',
      aiModel: geminiModel(),
    });
    prismaMock.botConfiguration.findUnique.mockResolvedValue(
      configRow({ frequencyPenalty: 0.7, presencePenalty: 0.4, temperature: 0.9 })
    );

    const res = await getConfig();

    expect(res.status).toBe(200);
    expect(res.body.data.effective.ignoredParams.sort()).toEqual([
      'frequencyPenalty',
      'presencePenalty',
    ]);
    // Temperature IS supported by Gemini, so it is applied — the filter is per-parameter,
    // not per-model.
    expect(res.body.data.effective.appliedParams.temperature).toBe(0.9);
    expect(res.body.data.effective.appliedParams).not.toHaveProperty('frequencyPenalty');
    // Stored values are untouched: ignoring a parameter is not deleting it, so switching
    // back to an OpenAI-style model restores the owner's setting.
    expect(res.body.data.config.generation.frequencyPenalty).toBe(0.7);
  });

  it('ignores nothing for a model that supports every parameter', async () => {
    arrangeRoute();
    botDetail({
      aiModelId: '66666666-6666-6666-6666-666666666666',
      aiModel: {
        enabled: true,
        capabilities: null,
        provider: { slug: 'openrouter', enabled: true },
      },
    });
    prismaMock.botConfiguration.findUnique.mockResolvedValue(
      configRow({ frequencyPenalty: 0.7, presencePenalty: 0.4 })
    );

    const res = await getConfig();

    expect(res.body.data.effective.ignoredParams).toEqual([]);
    expect(res.body.data.effective.appliedParams.frequencyPenalty).toBe(0.7);
    expect(res.body.data.effective.appliedParams.presencePenalty).toBe(0.4);
  });

  it('flags a promoted model when only the fallback is usable (§13.2)', async () => {
    arrangeRoute();
    botDetail({
      aiModelId: '66666666-6666-6666-6666-666666666666',
      fallbackAiModelId: '77777777-7777-7777-7777-777777777777',
      aiModel: {
        enabled: false,
        capabilities: null,
        provider: { slug: 'openrouter', enabled: true },
      },
      fallbackAiModel: {
        enabled: true,
        capabilities: null,
        provider: { slug: 'groq', enabled: true },
      },
    });
    noConfigRow();

    const res = await getConfig();

    // The UI must be able to say "your primary is down, the fallback is answering" instead
    // of silently serving from a model the owner did not choose.
    expect(res.body.data.effective.modelPromoted).toBe(true);
    expect(res.body.data.effective.modelUnavailable).toBe(false);
  });

  it('flags the model as unavailable when nothing can serve', async () => {
    arrangeRoute();
    botDetail({
      aiModelId: '66666666-6666-6666-6666-666666666666',
      aiModel: {
        enabled: false,
        capabilities: null,
        provider: { slug: 'openrouter', enabled: true },
      },
    });
    noConfigRow();

    const res = await getConfig();

    expect(res.body.data.effective.modelUnavailable).toBe(true);
    expect(res.body.data.effective.modelPromoted).toBe(false);
  });

  it('distinguishes "knowledge is on" from "this bot has knowledge" (§15.1)', async () => {
    arrangeRoute();
    botDetail();
    prismaMock.botConfiguration.findUnique.mockResolvedValue(
      configRow({ knowledgeEnabled: true, showSources: true })
    );
    prismaMock.knowledgeChunk.count.mockResolvedValue(0);

    const res = await getConfig();

    // Answers will still fall back, and this is the field that explains why.
    expect(res.body.data.config.knowledge.enabled).toBe(true);
    expect(res.body.data.effective.knowledgeActive).toBe(false);
  });

  it('never leaks a provider-native model id through `effective`', async () => {
    arrangeRoute();
    botDetail({
      aiModelId: '66666666-6666-6666-6666-666666666666',
      aiModel: {
        enabled: true,
        capabilities: null,
        provider: { slug: 'openrouter', enabled: true },
      },
    });
    noConfigRow();

    const res = await getConfig();

    // `effective` describes the *behaviour* of the configuration; the model identity a
    // workspace may act on is the internal uuid, and even that never appears here.
    expect(JSON.stringify(res.body)).not.toContain('providerModelId');
    expect(JSON.stringify(res.body)).not.toContain('openai/gpt-4o-mini');
  });
});

describe('POST /bots/:botId/config/reset', () => {
  it('restores a section and reports the new version (200)', async () => {
    arrangeRoute();
    botDetail();
    prismaMock.botConfiguration.findUnique
      .mockResolvedValueOnce(configRow({ version: 4, welcomeMessage: 'Custom greeting' }))
      .mockResolvedValueOnce(configRow({ version: 5 }));
    prismaMock.botConfiguration.upsert.mockResolvedValue(configRow({ version: 5 }));

    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/config/reset`)
      .set('Authorization', authHeader())
      .send({ section: 'conversation', expectedVersion: 4 });

    expect(res.status).toBe(200);
    // The write goes through `upsert` — a bot with no row resets to defaults by *creating*
    // the row, which is the same first-write behaviour every other config write has.
    const data = prismaMock.botConfiguration.upsert.mock.calls[0][0].update;
    expect(data.welcomeMessage).toBe(BOT_CONFIG_DEFAULTS.welcomeMessage);
    expect(data.version).toEqual({ increment: 1 });
    // Only the reset section's columns are written, so resetting one section cannot revert
    // an owner's work in another.
    expect(data).not.toHaveProperty('displayName');
  });

  it('is 409 on a stale version, like every other write', async () => {
    arrangeRoute();
    botDetail();
    prismaMock.botConfiguration.findUnique.mockResolvedValue(configRow({ version: 9 }));

    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/config/reset`)
      .set('Authorization', authHeader())
      .send({ section: 'all', expectedVersion: 2 });

    expect(res.status).toBe(409);
    expect(res.body.data.version).toBe(9);
    expect(prismaMock.botConfiguration.update).not.toHaveBeenCalled();
  });

  it('is 403 for an AGENT', async () => {
    arrangeRoute('AGENT');

    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/config/reset`)
      .set('Authorization', authHeader())
      .send({ section: 'all', expectedVersion: 0 });

    expect(res.status).toBe(403);
  });

  it('rejects an unknown section (400)', async () => {
    arrangeRoute();
    botDetail();

    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/config/reset`)
      .set('Authorization', authHeader())
      .send({ section: 'colourScheme', expectedVersion: 0 });

    expect(res.status).toBe(400);
  });
});
