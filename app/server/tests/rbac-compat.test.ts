import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/**
 * Checkpoint 3.5 — Compatibility & rollback verification.
 *
 * The RBAC rollback story: if the authorization middleware is removed from the route table,
 * the **service layer alone** must still isolate tenants. That holds only if every service
 * query is scoped by the caller's identity — which these tests pin.
 *
 * Checkpoint 4 moved that scope from `workspace.ownerId` to `members: { some: { userId } }`
 * (so ADMIN/AGENT members are admitted rather than only the owner). The isolation guarantee
 * is unchanged: a caller who is not in the scope gets a 404, and the scope predicate is
 * asserted here so a refactor that drops it fails loudly.
 *
 * `prisma/verify-backfill.ts` separately proves the memberships still mirror `ownerId`.
 */
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
  conversation: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  message: { create: vi.fn() },
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const USER_A = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'b@example.com' };
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

const membership = (userId: string, role: 'OWNER' | 'ADMIN' | 'AGENT' = 'OWNER') =>
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

describe('service-layer scope predicate is pinned (rollback safety)', () => {
  it('workspace reads are scoped to the caller’s membership', async () => {
    membership(USER_A.id);
    prismaMock.workspace.findFirst.mockResolvedValue({
      id: WORKSPACE_ID,
      name: 'Support',
      ownerId: USER_A.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/v1/workspaces/${WORKSPACE_ID}`)
      .set('Authorization', authHeader(USER_A));

    expect(res.status).toBe(200);
    expect(prismaMock.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: WORKSPACE_ID, members: { some: { userId: USER_A.id } } },
    });
  });

  it('bot reads are scoped through workspace membership', async () => {
    prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
    membership(USER_A.id);
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
    expect(prismaMock.bot.findFirst).toHaveBeenCalledWith({
      where: { id: BOT_ID, workspace: { members: { some: { userId: USER_A.id } } } },
    });
  });

  it('conversation reads are scoped through bot→workspace membership', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });
    membership(USER_A.id);
    prismaMock.conversation.findFirst.mockResolvedValue({
      id: CONVERSATION_ID,
      botId: BOT_ID,
      status: 'ACTIVE',
      assignedAgentId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
    });

    const res = await request(app)
      .get(`/api/v1/conversations/${CONVERSATION_ID}`)
      .set('Authorization', authHeader(USER_A));

    expect(res.status).toBe(200);
    expect(prismaMock.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: CONVERSATION_ID,
          bot: { workspace: { members: { some: { userId: USER_A.id } } } },
        },
      })
    );
  });
});

describe('cross-tenant access returns 404 (never 403) — existence is not leaked', () => {
  it('a non-member cannot read the workspace', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/workspaces/${WORKSPACE_ID}`)
      .set('Authorization', authHeader(USER_B));

    expect(res.status).toBe(404);
  });

  it('a non-member cannot read the bot', async () => {
    prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}`)
      .set('Authorization', authHeader(USER_B));

    expect(res.status).toBe(404);
  });

  it('a non-member cannot read the conversation', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/conversations/${CONVERSATION_ID}`)
      .set('Authorization', authHeader(USER_B));

    expect(res.status).toBe(404);
  });
});

describe('authentication still gates everything first', () => {
  it('unauthenticated requests are rejected before any authorization runs', async () => {
    const res = await request(app).get(`/api/v1/workspaces/${WORKSPACE_ID}`);

    expect(res.status).toBe(401);
    expect(prismaMock.workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.workspace.findFirst).not.toHaveBeenCalled();
  });
});
