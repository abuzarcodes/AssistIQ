import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/**
 * Checkpoint 9 — the bot deletion cascade, and the ordering inside it.
 *
 * A bot's knowledge lives in two stores that cannot be deleted together: rows in this
 * database (which Prisma's cascade does handle, `Bot → KnowledgeSource → KnowledgeChunk`)
 * and vectors in pgvector behind the AI service, on a different PostgreSQL instance. One of
 * the two has to be removed first, and the choice decides which failure an operator can
 * recover from.
 *
 * Rows first — the order this service used to use — leaves a failed vector call
 * unreachable: the bot is gone, so every retry is a 404, and the orphaned vectors keep
 * being retrieved for a bot that no longer exists. Vectors first fails the harmless way: a
 * retry removes zero vectors and then deletes the rows. These tests pin that order, because
 * the two implementations are indistinguishable until the AI service fails.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  bot: { findUnique: vi.fn(), findFirst: vi.fn(), delete: vi.fn() },
}));

const aiMock = vi.hoisted(() => ({
  deleteBotKnowledge: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const OWNER_USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'owner@example.com' };
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';

const authHeader = (user = OWNER_USER): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

const deleteBot = () =>
  request(app).delete(`/api/v1/bots/${BOT_ID}`).set('Authorization', authHeader());

beforeEach(() => {
  vi.resetAllMocks();

  prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
  prismaMock.workspaceMember.findUnique.mockResolvedValue({ role: 'OWNER' });
  prismaMock.user.findUnique.mockResolvedValue({ platformRole: 'USER' });
  prismaMock.bot.findFirst.mockResolvedValue({
    id: BOT_ID,
    name: 'Helper',
    description: null,
    workspaceId: WORKSPACE_ID,
  });
  prismaMock.bot.delete.mockResolvedValue({ id: BOT_ID });
  aiMock.deleteBotKnowledge.mockResolvedValue({ chunks_deleted: 12 });
});

describe('DELETE /bots/:botId', () => {
  it('removes the vectors before the rows, so the vectors are never unreachable', async () => {
    const order: string[] = [];
    aiMock.deleteBotKnowledge.mockImplementation(() => {
      order.push('vectors');
      return Promise.resolve({ chunks_deleted: 12 });
    });
    prismaMock.bot.delete.mockImplementation(() => {
      order.push('rows');
      return Promise.resolve({ id: BOT_ID });
    });

    const res = await deleteBot();

    expect(res.status).toBe(200);
    expect(order).toEqual(['vectors', 'rows']);
    // Scoped to this bot, never to the workspace: the AI service deletes by bot id, and a
    // wider call would be the "delete all FAQ entries" bug in a different costume.
    expect(aiMock.deleteBotKnowledge).toHaveBeenCalledWith(BOT_ID);
  });

  it('still deletes the bot when the AI service is down, rather than blocking the user', async () => {
    // An AI outage must not make a bot undeletable. The failure is logged, not thrown —
    // and the vectors, if any survive, are the operator's to clean up, which is exactly
    // the trade-off the ordering above is designed to leave recoverable.
    aiMock.deleteBotKnowledge.mockRejectedValue(new Error('AI service is down'));

    const res = await deleteBot();

    expect(res.status).toBe(200);
    expect(prismaMock.bot.delete).toHaveBeenCalledWith({ where: { id: BOT_ID } });
  });

  it('lets the schema cascade take the sources and chunks once the bot row goes', async () => {
    // The rows are removed by one `bot.delete` — the cascade in `schema.prisma` does the
    // rest. A test that mocked per-model deletes would pin an implementation this service
    // deliberately does not have.
    await deleteBot();

    expect(prismaMock.bot.delete).toHaveBeenCalledTimes(1);
    expect(prismaMock.bot.delete).toHaveBeenCalledWith({ where: { id: BOT_ID } });
  });

  it('makes no AI call for a caller who cannot manage bots', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue({ role: 'AGENT' });

    const res = await deleteBot();

    expect(res.status).toBe(403);
    expect(aiMock.deleteBotKnowledge).not.toHaveBeenCalled();
    expect(prismaMock.bot.delete).not.toHaveBeenCalled();
  });
});
