import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { BOT_CONFIG_DEFAULTS } from '../src/constants/botDefaults.js';

/**
 * Checkpoint 5 — per-message feedback (§10.6, §23.1).
 *
 * The properties that matter: only ASSISTANT messages are ratable, a foreign message is
 * indistinguishable from a missing one, feedback is one row per message (re-rating updates),
 * and a disabled bot answers 409 rather than silently doing nothing.
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
const MESSAGE_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_MESSAGE_ID = '55555555-5555-5555-5555-555555555555';

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

const prime = (configOverrides: Record<string, unknown> = {}, messageRole = 'ASSISTANT') => {
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
    configRow({ feedbackEnabled: true, ...configOverrides })
  );
  prismaMock.message.findFirst.mockResolvedValue({ id: MESSAGE_ID, role: messageRole });
  prismaMock.messageFeedback.upsert.mockResolvedValue({ id: 'fb-1', rating: 'UP' });
  prismaMock.messageFeedback.delete.mockResolvedValue({});
};

const post = (body: Record<string, unknown>, messageId = MESSAGE_ID) =>
  request(app)
    .post(`/api/v1/conversations/${CONVERSATION_ID}/messages/${messageId}/feedback`)
    .set('Authorization', authHeader())
    .send(body);

beforeEach(() => {
  vi.resetAllMocks();
});

describe('feedback — happy path', () => {
  it('records an UP rating (200)', async () => {
    prime();
    const res = await post({ rating: 'UP' });

    expect(res.status).toBe(200);
    expect(prismaMock.messageFeedback.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { messageId: MESSAGE_ID },
        create: expect.objectContaining({ messageId: MESSAGE_ID, conversationId: CONVERSATION_ID, rating: 'UP' }),
      })
    );
  });

  it('records a DOWN rating with a reason and comment', async () => {
    prime();
    const res = await post({ rating: 'DOWN', reason: 'INACCURATE', comment: 'It was wrong.' });

    expect(res.status).toBe(200);
    const args = prismaMock.messageFeedback.upsert.mock.calls[0][0];
    expect(args.create.reason).toBe('INACCURATE');
    expect(args.create.comment).toBe('It was wrong.');
  });

  it('re-rates via upsert rather than duplicating', async () => {
    prime();
    await post({ rating: 'UP' });
    await post({ rating: 'DOWN' });

    expect(prismaMock.messageFeedback.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.messageFeedback.upsert.mock.calls[1][0].update.rating).toBe('DOWN');
  });
});

describe('feedback — gates', () => {
  it('409 when feedback is disabled for the bot', async () => {
    prime({ feedbackEnabled: false });
    const res = await post({ rating: 'UP' });

    expect(res.status).toBe(409);
    expect(prismaMock.messageFeedback.upsert).not.toHaveBeenCalled();
  });

  it('400 on a USER message', async () => {
    prime({}, 'USER');
    const res = await post({ rating: 'UP' });

    expect(res.status).toBe(400);
    expect(prismaMock.messageFeedback.upsert).not.toHaveBeenCalled();
  });

  it('404 for a message in another conversation', async () => {
    prime();
    prismaMock.message.findFirst.mockResolvedValue(null); // scoped query finds nothing
    const res = await post({ rating: 'UP' }, OTHER_MESSAGE_ID);

    expect(res.status).toBe(404);
    expect(prismaMock.messageFeedback.upsert).not.toHaveBeenCalled();
  });

  it('400 on an invalid rating', async () => {
    prime();
    const res = await post({ rating: 'SIDEWAYS' });

    expect(res.status).toBe(400);
    expect(prismaMock.messageFeedback.upsert).not.toHaveBeenCalled();
  });

  it('400 on a reason outside the fixed vocabulary', async () => {
    prime();
    const res = await post({ rating: 'DOWN', reason: 'BECAUSE' });

    expect(res.status).toBe(400);
  });
});

describe('feedback — delete', () => {
  it('removes an existing rating (200)', async () => {
    prime();
    prismaMock.messageFeedback.findUnique.mockResolvedValue({ id: 'fb-1' });

    const res = await request(app)
      .delete(`/api/v1/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}/feedback`)
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(prismaMock.messageFeedback.delete).toHaveBeenCalledWith({ where: { messageId: MESSAGE_ID } });
  });

  it('404 when there is nothing to remove', async () => {
    prime();
    prismaMock.messageFeedback.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/v1/conversations/${CONVERSATION_ID}/messages/${MESSAGE_ID}/feedback`)
      .set('Authorization', authHeader());

    expect(res.status).toBe(404);
    expect(prismaMock.messageFeedback.delete).not.toHaveBeenCalled();
  });
});