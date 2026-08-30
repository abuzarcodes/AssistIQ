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

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/workspaces', () => {
  it('creates a workspace owned by the authenticated user (201)', async () => {
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
    // The owner id comes from the token, never the client body.
    expect(prismaMock.workspace.create).toHaveBeenCalledWith({
      data: { name: 'Support', ownerId: USER_A.id },
    });
  });

  it('rejects creation without a token (401)', async () => {
    const res = await request(app).post('/api/v1/workspaces').send({ name: 'Support' });
    expect(res.status).toBe(401);
    expect(prismaMock.workspace.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/workspaces/:workspaceId (tenant isolation)', () => {
  it('returns 404 when the workspace belongs to another user', async () => {
    // The ownership-scoped query finds nothing for user B, so no data leaks.
    prismaMock.workspace.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/workspaces/${WORKSPACE_ID}`)
      .set('Authorization', authHeader(USER_B));

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    // The isolation is enforced in the query: it is scoped to the caller's id.
    expect(prismaMock.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: WORKSPACE_ID, ownerId: USER_B.id },
    });
  });

  it('returns the workspace to its owner (200)', async () => {
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
  });
});
