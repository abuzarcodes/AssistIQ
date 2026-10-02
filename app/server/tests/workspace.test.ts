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

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

/** Stub the membership lookup the workspace permission middleware performs. */
const membershipFor = (userId: string, role: 'OWNER' | 'ADMIN' | 'AGENT' = 'OWNER') =>
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

describe('POST /api/v1/workspaces', () => {
  it('creates a workspace with the caller as an OWNER member (201)', async () => {
    prismaMock.workspace.create.mockResolvedValue({
      id: WORKSPACE_ID,
      name: 'Support',
      ownerId: USER_A.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', authHeader(USER_A))
      .send({ name: 'Support' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe('Support');
    // The owner id comes from the token, never the client body, and the RBAC membership is
    // written in the same statement so a workspace can never exist without an OWNER.
    expect(prismaMock.workspace.create).toHaveBeenCalledWith({
      data: {
        name: 'Support',
        ownerId: USER_A.id,
        members: { create: { userId: USER_A.id, role: 'OWNER' } },
      },
    });
  });

  it('rejects creation without a token (401)', async () => {
    const res = await request(app).post('/api/v1/workspaces').send({ name: 'Support' });
    expect(res.status).toBe(401);
    expect(prismaMock.workspace.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/workspaces (membership scoped)', () => {
  it('lists only workspaces the caller is a member of', async () => {
    prismaMock.workspace.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/v1/workspaces').set('Authorization', authHeader(USER_B));

    expect(res.status).toBe(200);
    expect(prismaMock.workspace.findMany).toHaveBeenCalledWith({
      where: { members: { some: { userId: USER_B.id } } },
      orderBy: { createdAt: 'desc' },
    });
  });
});

describe('GET /api/v1/workspaces/:workspaceId (tenant isolation)', () => {
  it('returns 404 when the caller is not a member of the workspace', async () => {
    // The permission middleware finds no membership for user B, so the request never
    // reaches the service and no data leaks.
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/workspaces/${WORKSPACE_ID}`)
      .set('Authorization', authHeader(USER_B));

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(prismaMock.workspace.findFirst).not.toHaveBeenCalled();
  });

  it('returns the workspace to a member, scoping the query to their membership (200)', async () => {
    membershipFor(USER_A.id, 'OWNER');
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
    expect(res.body.data.id).toBe(WORKSPACE_ID);
    // Defence in depth: the service query is still scoped to the caller's membership.
    expect(prismaMock.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: WORKSPACE_ID, members: { some: { userId: USER_A.id } } },
    });
  });

  it('allows an AGENT to view the workspace (workspace:view)', async () => {
    membershipFor(USER_B.id, 'AGENT');
    prismaMock.workspace.findFirst.mockResolvedValue({
      id: WORKSPACE_ID,
      name: 'Support',
      ownerId: USER_A.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/v1/workspaces/${WORKSPACE_ID}`)
      .set('Authorization', authHeader(USER_B));

    expect(res.status).toBe(200);
  });
});
