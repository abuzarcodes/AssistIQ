import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn() },
  workspace: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  bot: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  knowledgeEntry: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  conversation: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  message: { create: vi.fn() },
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const USER_A = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'b@example.com' };
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/workspaces/:workspaceId/bots', () => {
  it('creates a bot after confirming the caller owns the workspace (201)', async () => {
    prismaMock.workspace.findFirst.mockResolvedValue({
      id: WORKSPACE_ID,
      name: 'Support',
      ownerId: USER_A.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prismaMock.bot.create.mockResolvedValue({
      id: BOT_ID,
      name: 'Helper',
      description: 'Answers FAQs',
      workspaceId: WORKSPACE_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/bots`)
      .set('Authorization', authHeader(USER_A))
      .send({ name: 'Helper', description: 'Answers FAQs' });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Helper');
    // Ownership of the parent workspace is asserted (scoped to the caller) before insert.
    expect(prismaMock.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: WORKSPACE_ID, ownerId: USER_A.id },
    });
    expect(prismaMock.bot.create).toHaveBeenCalled();
  });

  it('cannot create a bot in a workspace owned by another user (404)', async () => {
    // User B does not own the workspace, so the ownership gate finds nothing.
    prismaMock.workspace.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/bots`)
      .set('Authorization', authHeader(USER_B))
      .send({ name: 'Intruder' });

    expect(res.status).toBe(404);
    expect(prismaMock.bot.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/bots/:botId (tenant isolation)', () => {
  it('returns 404 when the bot belongs to another user', async () => {
    prismaMock.bot.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}`)
      .set('Authorization', authHeader(USER_B));

    expect(res.status).toBe(404);
    // Isolation is enforced by joining bot -> workspace -> ownerId in the query.
    expect(prismaMock.bot.findFirst).toHaveBeenCalledWith({
      where: { id: BOT_ID, workspace: { ownerId: USER_B.id } },
    });
  });

  it('returns the bot to its owner (200)', async () => {
    prismaMock.bot.findFirst.mockResolvedValue({
      id: BOT_ID,
      name: 'Helper',
      description: null,
      workspaceId: WORKSPACE_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}`)
      .set('Authorization', authHeader(USER_A));

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(BOT_ID);
  });
});
