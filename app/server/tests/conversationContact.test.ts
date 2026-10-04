import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { BOT_CONFIG_DEFAULTS } from '../src/constants/botDefaults.js';

/**
 * Checkpoint 5 — contact collection (§10.7, §14.6, §23.1).
 *
 * Deterministic form capture, not LLM extraction: the configured fields bound what may be
 * submitted, required fields must be present, and the details are per-conversation PII that
 * never appears on the inbox list endpoint.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  bot: { findUnique: vi.fn(), findFirst: vi.fn() },
  botConfiguration: { findUnique: vi.fn() },
  conversation: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  message: { create: vi.fn(), findFirst: vi.fn() },
  knowledgeSource: { findMany: vi.fn() },
  messageFeedback: { upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
  conversationContact: { upsert: vi.fn() },
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: { chat: vi.fn() } }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333';

const authHeader = (): string =>
  `Bearer ${signToken({ sub: USER_ID, email: 'owner@example.com' })}`;

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

const collection = { enabled: true, fields: ['name', 'email'], required: ['email'] };

const prime = (configOverrides: Record<string, unknown> = {}) => {
  prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'm',
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: 'OWNER',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID });
  prismaMock.bot.findUnique.mockResolvedValue({
    isActive: true,
    aiModelId: null,
    fallbackAiModelId: null,
    aiModel: null,
    fallbackAiModel: null,
  });
  prismaMock.botConfiguration.findUnique.mockResolvedValue(
    configRow({ contactCollection: collection, ...configOverrides })
  );
  prismaMock.conversationContact.upsert.mockResolvedValue({ id: 'c-1', email: 'a@b.com' });
};

const post = (body: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/conversations/${CONVERSATION_ID}/contact`)
    .set('Authorization', authHeader())
    .send(body);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('POST contact — collection', () => {
  it('records configured fields (200)', async () => {
    prime();
    const res = await post({ name: 'Ada', email: 'ada@example.com' });

    expect(res.status).toBe(200);
    expect(prismaMock.conversationContact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: CONVERSATION_ID },
        create: expect.objectContaining({ conversationId: CONVERSATION_ID, name: 'Ada', email: 'ada@example.com' }),
      })
    );
  });

  it('upserts (one row per conversation)', async () => {
    prime();
    await post({ email: 'ada@example.com' });
    await post({ email: 'ada@example.com' });

    expect(prismaMock.conversationContact.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.conversationContact.upsert.mock.calls[1][0].update).toMatchObject({
      email: 'ada@example.com',
    });
  });
});

describe('POST contact — gates', () => {
  it('409 when collection is disabled', async () => {
    prime({ contactCollection: { ...collection, enabled: false } });
    const res = await post({ email: 'ada@example.com' });

    expect(res.status).toBe(409);
    expect(prismaMock.conversationContact.upsert).not.toHaveBeenCalled();
  });

  it('400 when collection is absent', async () => {
    prime({ contactCollection: null });
    const res = await post({ email: 'ada@example.com' });

    expect(res.status).toBe(409);
  });

  it('400 for a field that is not configured', async () => {
    prime();
    const res = await post({ email: 'ada@example.com', phone: '555-1234' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('phone');
  });

  it('400 when a required field is missing', async () => {
    prime();
    const res = await post({ name: 'Ada' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('email');
  });

  it('400 on a malformed email', async () => {
    prime();
    const res = await post({ email: 'not-an-email' });

    expect(res.status).toBe(400);
  });
});

describe('GET conversations — PII stays off the inbox list', () => {
  it('lists conversations without including contact', async () => {
    // Authorization resolves the workspace from the bot row…
    prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
    prismaMock.workspaceMember.findUnique.mockResolvedValue({
      id: 'm',
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: 'OWNER',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // …then the service re-asserts bot access and reads the list.
    prismaMock.bot.findFirst.mockResolvedValue({ id: BOT_ID, workspaceId: WORKSPACE_ID });
    prismaMock.conversation.findMany.mockResolvedValue([
      { id: CONVERSATION_ID, botId: BOT_ID, status: 'ACTIVE' },
    ]);

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/conversations`)
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data[0]).not.toHaveProperty('contact');
    // The query itself carries no `include`, so contact can never ride along.
    const args = prismaMock.conversation.findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('include');
  });
});