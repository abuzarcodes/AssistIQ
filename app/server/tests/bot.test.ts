import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn() },
  workspaceMember: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  workspace: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  bot: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  knowledgeEntry: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  conversation: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
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

/** The workspace the bot belongs to, as resolved by the middleware's 'bot' scope. */
const botBelongsToWorkspace = (workspaceId = WORKSPACE_ID) =>
  prismaMock.bot.findUnique.mockResolvedValue({ workspaceId });

const membership = (userId: string, role: 'OWNER' | 'ADMIN' | 'AGENT') =>
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'member-1',
    userId,
    workspaceId: WORKSPACE_ID,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/workspaces/:workspaceId/bots', () => {
  it('creates a bot when the caller may manage bots in the workspace (201)', async () => {
    membership(USER_A.id, 'OWNER');
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
    expect(prismaMock.bot.create).toHaveBeenCalled();
  });

  it('rejects a non-member with 404 and creates nothing', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/bots`)
      .set('Authorization', authHeader(USER_B))
      .send({ name: 'Intruder' });

    expect(res.status).toBe(404);
    expect(prismaMock.bot.create).not.toHaveBeenCalled();
  });

  it('rejects an AGENT with 403 (no bots:manage) and creates nothing', async () => {
    membership(USER_B.id, 'AGENT');

    const res = await request(app)
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/bots`)
      .set('Authorization', authHeader(USER_B))
      .send({ name: 'Sneaky' });

    expect(res.status).toBe(403);
    expect(prismaMock.bot.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/bots/:botId (tenant isolation)', () => {
  it('returns 404 when the bot does not exist / is not reachable', async () => {
    prismaMock.bot.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}`)
      .set('Authorization', authHeader(USER_B));

    expect(res.status).toBe(404);
    // The workspace is resolved through the bot before any membership check.
    expect(prismaMock.bot.findUnique).toHaveBeenCalledWith({
      where: { id: BOT_ID },
      select: { workspaceId: true },
    });
  });

  it('returns 404 when the caller is not a member of the bot’s workspace', async () => {
    botBelongsToWorkspace();
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}`)
      .set('Authorization', authHeader(USER_B));

    expect(res.status).toBe(404);
    expect(prismaMock.bot.findFirst).not.toHaveBeenCalled();
  });

  it('returns the bot to a member and scopes the query to their membership (200)', async () => {
    botBelongsToWorkspace();
    membership(USER_A.id, 'ADMIN');
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
    // The scope predicate is the contract this test guards. Checkpoint 3 added an
    // `aiModel` include to the same query, so the assertion is scoped to `where` rather
    // than matching the whole argument object.
    expect(prismaMock.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BOT_ID, workspace: { members: { some: { userId: USER_A.id } } } },
      })
    );
  });
});
