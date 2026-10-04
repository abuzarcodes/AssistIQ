import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/**
 * Checkpoint 7 — the preview endpoint (§17.2, §23.1).
 *
 * The load-bearing property is that previewing persists **nothing**: it validates a draft,
 * resolves the bot's stored models, calls the production chat endpoint, and writes no row.
 * A test asserts the write mocks stay untouched — the same style as the "no AI call when the
 * model is unusable" assertions.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  bot: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  botConfiguration: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  knowledgeSource: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  knowledgeChunk: { count: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  conversation: { create: vi.fn(), update: vi.fn() },
  message: { create: vi.fn() },
  messageFeedback: { upsert: vi.fn(), delete: vi.fn() },
  conversationContact: { upsert: vi.fn() },
  knowledgeEntry: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

const aiMock = vi.hoisted(() => ({ chat: vi.fn() }));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';

const authHeader = (): string =>
  `Bearer ${signToken({ sub: USER_ID, email: 'owner@example.com' })}`;

/** A complete, valid grouped draft (Appendix B). */
const draft = (overrides: Record<string, unknown> = {}) => ({
  general: { isActive: true, displayName: null, hasAvatar: false, avatarVersion: 0 },
  personality: {
    preset: 'PROFESSIONAL',
    tone: 'NEUTRAL',
    customPersonality: null,
    customInstructions: null,
    responseLanguage: 'AUTO',
    responseLength: 'BALANCED',
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
  knowledge: { enabled: true, strictness: 'BALANCED', showSources: false, topK: 3 },
  generation: {
    temperature: 0.2,
    topP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    maxOutputTokens: null,
  },
  model: { aiModelId: null, fallbackAiModelId: null },
  humanSupport: {
    fallbackEnabled: true,
    fallbackMessage: null,
    humanRequestBehavior: 'TRANSFER_AUTOMATICALLY',
    handoffMessage: null,
    businessHours: null,
    contactCollection: null,
  },
  ...overrides,
});

const writeMocks = (): ReturnType<typeof vi.fn>[] => [
  prismaMock.bot.update,
  prismaMock.bot.create,
  prismaMock.bot.delete,
  prismaMock.botConfiguration.upsert,
  prismaMock.botConfiguration.update,
  prismaMock.knowledgeSource.create,
  prismaMock.knowledgeSource.update,
  prismaMock.knowledgeSource.delete,
  prismaMock.knowledgeChunk.create,
  prismaMock.knowledgeChunk.update,
  prismaMock.knowledgeChunk.delete,
  prismaMock.conversation.create,
  prismaMock.conversation.update,
  prismaMock.message.create,
  prismaMock.messageFeedback.upsert,
  prismaMock.messageFeedback.delete,
  prismaMock.conversationContact.upsert,
  prismaMock.knowledgeEntry.create,
  prismaMock.knowledgeEntry.update,
  prismaMock.knowledgeEntry.delete,
];

const expectNoWrites = () => {
  for (const mock of writeMocks()) expect(mock).not.toHaveBeenCalled();
};

const post = (body: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/bots/${BOT_ID}/config/preview`)
    .set('Authorization', authHeader())
    .send(body);

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.bot.findUnique.mockResolvedValue({
    workspaceId: WORKSPACE_ID,
    aiModelId: null,
    fallbackAiModelId: null,
    aiModel: null,
    fallbackAiModel: null,
  });
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'm',
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: 'OWNER',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  prismaMock.bot.findFirst.mockResolvedValue({ id: BOT_ID, workspaceId: WORKSPACE_ID });
  prismaMock.bot.findUniqueOrThrow.mockResolvedValue({ aiModel: null, fallbackAiModel: null });
  prismaMock.knowledgeSource.findMany.mockResolvedValue([]);
  aiMock.chat.mockResolvedValue({
    status: 'success',
    response: 'Refunds take five business days.',
    fallback_required: false,
  });
});

describe('POST /bots/:botId/config/preview', () => {
  it('returns a real answer and persists nothing', async () => {
    const res = await post({ message: 'How do refunds work?', draft: draft() });

    expect(res.status).toBe(200);
    expect(res.body.data.response).toBe('Refunds take five business days.');
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
    expectNoWrites();
  });

  it('sends the draft configuration to the AI service', async () => {
    await post({ message: 'hi', draft: draft() });

    const payload = aiMock.chat.mock.calls[0][0];
    expect(payload.bot_id).toBe(BOT_ID);
    expect(payload.config).toBeDefined();
    expect(payload.config.params.temperature).toBe(0.2);
  });

  it('resolves models from the stored ids, never from the draft', async () => {
    // The draft names a model; the bot has none stored. The draft's model must be ignored.
    await post({
      message: 'hi',
      draft: draft({
        model: {
          aiModelId: '99999999-9999-9999-9999-999999999999',
          fallbackAiModelId: null,
        },
      }),
    });

    const payload = aiMock.chat.mock.calls[0][0];
    expect('model' in payload).toBe(false);
  });

  it('reports the applied parameters from the draft', async () => {
    const res = await post({ message: 'hi', draft: draft() });

    expect(res.body.data.appliedParams).toMatchObject({ temperature: 0.2 });
    expect(res.body.data.ignoredParams).toEqual([]);
  });

  it('rejects an invalid draft with 400 (never silently falls back to defaults)', async () => {
    const res = await post({ message: 'hi', draft: { general: {} } });

    expect(res.status).toBe(400);
    expect(aiMock.chat).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('rejects an empty message with 400', async () => {
    const res = await post({ message: '', draft: draft() });

    expect(res.status).toBe(400);
    expect(aiMock.chat).not.toHaveBeenCalled();
  });

  it('requires bots:manage — an AGENT is refused with 403', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue({
      id: 'm',
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: 'AGENT',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await post({ message: 'hi', draft: draft() });

    expect(res.status).toBe(403);
    expect(aiMock.chat).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('a non-member gets 404', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await post({ message: 'hi', draft: draft() });

    expect(res.status).toBe(404);
    expect(aiMock.chat).not.toHaveBeenCalled();
  });

  it('short-circuits without an AI call when the stored model is unusable', async () => {
    prismaMock.bot.findUnique.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      aiModelId: 'm',
      fallbackAiModelId: null,
      aiModel: {
        providerModelId: 'x',
        enabled: false,
        provider: { slug: 'openrouter', enabled: true },
      },
      fallbackAiModel: null,
    });

    const res = await post({ message: 'hi', draft: draft() });

    expect(res.status).toBe(200);
    expect(res.body.data.fallback_required).toBe(true);
    expect(aiMock.chat).not.toHaveBeenCalled();
    expectNoWrites();
  });
});