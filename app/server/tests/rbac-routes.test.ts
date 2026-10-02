import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  workspaceMember: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  workspace: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
  },
  bot: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
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
    count: vi.fn(),
  },
  message: { create: vi.fn() },
}));

const aiMock = vi.hoisted(() => ({
  getAiStatus: vi.fn(),
  getSystemStatus: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const OWNER_USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'owner@example.com' };
const AGENT_USER = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'agent@example.com' };
const PLATFORM_USER = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', email: 'platform@example.com' };
const TARGET_USER = { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', email: 'target@example.com' };

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '44444444-4444-4444-4444-444444444444';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

/** A membership row as Prisma would return it. */
const memberRecord = (userId: string, role: string) => ({
  id: `member-${userId}`,
  userId,
  workspaceId: WORKSPACE_ID,
  role,
  createdAt: new Date(),
  updatedAt: new Date(),
});

/**
 * Drive `workspaceMember.findUnique` from a map of userId → role. Both the permission
 * middleware (caller's membership) and the member service (duplicate check for the target
 * user) go through this method, so the map covers both.
 */
const setMemberships = (map: Record<string, string | null>): void => {
  prismaMock.workspaceMember.findUnique.mockImplementation(
    (args: { where?: { userId_workspaceId?: { userId?: string } } }) => {
      const userId = args?.where?.userId_workspaceId?.userId;
      const role = userId ? map[userId] : null;
      return Promise.resolve(role ? memberRecord(userId as string, role) : null);
    }
  );
};

const setPlatformRole = (role: 'USER' | 'PLATFORM_OWNER'): void => {
  prismaMock.user.findUnique.mockResolvedValue({ platformRole: role });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AI Lab routes are now platform-owner only (audit finding closed)', () => {
  it('a normal authenticated user gets 403 on /admin/ai/status', async () => {
    setPlatformRole('USER');

    const res = await request(app)
      .get('/api/v1/admin/ai/status')
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(403);
    expect(aiMock.getAiStatus).not.toHaveBeenCalled();
  });

  it('a PLATFORM_OWNER reaches /admin/ai/status', async () => {
    setPlatformRole('PLATFORM_OWNER');
    aiMock.getAiStatus.mockResolvedValue({ status: 'ok' });

    const res = await request(app)
      .get('/api/v1/admin/ai/status')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(200);
    expect(aiMock.getAiStatus).toHaveBeenCalledTimes(1);
  });

  it('unauthenticated access is still 401', async () => {
    const res = await request(app).get('/api/v1/admin/ai/status');
    expect(res.status).toBe(401);
  });
});

describe('platform routes', () => {
  it('a normal user gets 403 on /platform/users', async () => {
    setPlatformRole('USER');

    const res = await request(app)
      .get('/api/v1/platform/users')
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(403);
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });

  it('a PLATFORM_OWNER lists users (password hash never selected)', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.user.findMany.mockResolvedValue([
      { id: 'u1', name: 'A', email: 'a@example.com', platformRole: 'USER', createdAt: new Date(), updatedAt: new Date() },
    ]);

    const res = await request(app)
      .get('/api/v1/platform/users')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // The projection is explicit — the hash is not part of it.
    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ id: true, email: true, platformRole: true }),
      })
    );
    expect(prismaMock.user.findMany.mock.calls[0][0].select).not.toHaveProperty('passwordHash');
  });

  it('lists every workspace for a PLATFORM_OWNER (no membership filter)', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.workspace.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/v1/platform/workspaces')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(200);
    expect(prismaMock.workspace.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ where: expect.anything() })
    );
  });

  it('reports system status and degrades gracefully when the AI service is down', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.user.count.mockResolvedValue(3);
    prismaMock.workspace.count.mockResolvedValue(2);
    prismaMock.bot.count.mockResolvedValue(1);
    prismaMock.conversation.count.mockResolvedValue(5);
    aiMock.getSystemStatus.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(app)
      .get('/api/v1/platform/system')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(200);
    expect(res.body.data.aiService.reachable).toBe(false);
    expect(res.body.data.counts).toEqual({ users: 3, workspaces: 2, bots: 1, conversations: 5 });
  });
});

describe('workspace member management', () => {
  it('OWNER can list members (members:view)', async () => {
    setMemberships({ [OWNER_USER.id]: 'OWNER' });
    prismaMock.workspaceMember.findMany.mockResolvedValue([memberRecord(OWNER_USER.id, 'OWNER')]);

    const res = await request(app)
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/members`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('AGENT gets 403 listing members (no members:view)', async () => {
    setMemberships({ [AGENT_USER.id]: 'AGENT' });

    const res = await request(app)
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/members`)
      .set('Authorization', authHeader(AGENT_USER));

    expect(res.status).toBe(403);
  });

  it('a non-member gets 404 (not 403) — no tenant leak', async () => {
    setMemberships({});

    const res = await request(app)
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/members`)
      .set('Authorization', authHeader(AGENT_USER));

    expect(res.status).toBe(404);
  });

  it('OWNER can add an existing user by email (201)', async () => {
    setMemberships({ [OWNER_USER.id]: 'OWNER' });
    prismaMock.user.findUnique.mockResolvedValue({ id: TARGET_USER.id, email: TARGET_USER.email });
    prismaMock.workspaceMember.create.mockResolvedValue(memberRecord(TARGET_USER.id, 'AGENT'));

    const res = await request(app)
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/members`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ email: TARGET_USER.email, role: 'AGENT' });

    expect(res.status).toBe(201);
    expect(prismaMock.workspaceMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { workspaceId: WORKSPACE_ID, userId: TARGET_USER.id, role: 'AGENT' },
      })
    );
  });

  it('ADMIN cannot add members (403 — members:manage is OWNER only)', async () => {
    setMemberships({ [AGENT_USER.id]: 'ADMIN' });

    const res = await request(app)
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/members`)
      .set('Authorization', authHeader(AGENT_USER))
      .send({ email: TARGET_USER.email, role: 'AGENT' });

    expect(res.status).toBe(403);
    expect(prismaMock.workspaceMember.create).not.toHaveBeenCalled();
  });

  it('adding an unknown email returns 404', async () => {
    setMemberships({ [OWNER_USER.id]: 'OWNER' });
    prismaMock.user.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/members`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ email: 'ghost@example.com', role: 'AGENT' });

    expect(res.status).toBe(404);
  });

  it('adding an existing member returns 409', async () => {
    setMemberships({ [OWNER_USER.id]: 'OWNER', [TARGET_USER.id]: 'AGENT' });
    prismaMock.user.findUnique.mockResolvedValue({ id: TARGET_USER.id, email: TARGET_USER.email });

    const res = await request(app)
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/members`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ email: TARGET_USER.email, role: 'AGENT' });

    expect(res.status).toBe(409);
  });

  it('rejects an invalid role (400)', async () => {
    setMemberships({ [OWNER_USER.id]: 'OWNER' });

    const res = await request(app)
      .post(`/api/v1/workspaces/${WORKSPACE_ID}/members`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ email: TARGET_USER.email, role: 'SUPERUSER' });

    expect(res.status).toBe(400);
  });

  it('OWNER can change a member role (200)', async () => {
    setMemberships({ [OWNER_USER.id]: 'OWNER' });
    prismaMock.workspaceMember.findFirst.mockResolvedValue(memberRecord(TARGET_USER.id, 'AGENT'));
    prismaMock.workspace.findUnique.mockResolvedValue({ ownerId: OWNER_USER.id });
    prismaMock.workspaceMember.update.mockResolvedValue(memberRecord(TARGET_USER.id, 'ADMIN'));

    const res = await request(app)
      .patch(`/api/v1/workspaces/${WORKSPACE_ID}/members/${MEMBER_ID}`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ role: 'ADMIN' });

    expect(res.status).toBe(200);
    expect(prismaMock.workspaceMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MEMBER_ID }, data: { role: 'ADMIN' } })
    );
  });

  it('refuses to change the workspace owner’s own membership (400)', async () => {
    setMemberships({ [OWNER_USER.id]: 'OWNER' });
    // The targeted member IS the workspace owner.
    prismaMock.workspaceMember.findFirst.mockResolvedValue(memberRecord(OWNER_USER.id, 'OWNER'));
    prismaMock.workspace.findUnique.mockResolvedValue({ ownerId: OWNER_USER.id });

    const res = await request(app)
      .patch(`/api/v1/workspaces/${WORKSPACE_ID}/members/${MEMBER_ID}`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ role: 'AGENT' });

    expect(res.status).toBe(400);
    expect(prismaMock.workspaceMember.update).not.toHaveBeenCalled();
  });

  it('OWNER can remove a member (200)', async () => {
    setMemberships({ [OWNER_USER.id]: 'OWNER' });
    prismaMock.workspaceMember.findFirst.mockResolvedValue(memberRecord(TARGET_USER.id, 'AGENT'));
    prismaMock.workspace.findUnique.mockResolvedValue({ ownerId: OWNER_USER.id });
    prismaMock.workspaceMember.delete.mockResolvedValue(memberRecord(TARGET_USER.id, 'AGENT'));

    const res = await request(app)
      .delete(`/api/v1/workspaces/${WORKSPACE_ID}/members/${MEMBER_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(prismaMock.workspaceMember.delete).toHaveBeenCalledWith({ where: { id: MEMBER_ID } });
  });

  it('refuses to remove the workspace owner (400)', async () => {
    setMemberships({ [OWNER_USER.id]: 'OWNER' });
    prismaMock.workspaceMember.findFirst.mockResolvedValue(memberRecord(OWNER_USER.id, 'OWNER'));
    prismaMock.workspace.findUnique.mockResolvedValue({ ownerId: OWNER_USER.id });

    const res = await request(app)
      .delete(`/api/v1/workspaces/${WORKSPACE_ID}/members/${MEMBER_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(400);
    expect(prismaMock.workspaceMember.delete).not.toHaveBeenCalled();
  });

  it('returns 404 for a member id that is not in this workspace', async () => {
    setMemberships({ [OWNER_USER.id]: 'OWNER' });
    prismaMock.workspaceMember.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/v1/workspaces/${WORKSPACE_ID}/members/${MEMBER_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(404);
  });
});
