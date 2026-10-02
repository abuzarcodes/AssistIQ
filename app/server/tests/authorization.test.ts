import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Minimal Prisma surface used by the authorization layer. Only the reads the middleware
// performs are needed here; everything else is inert.
const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn() },
  workspaceMember: { findUnique: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
  workspace: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  bot: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  knowledgeEntry: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  conversation: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  message: { create: vi.fn() },
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { authenticate } = await import('../src/middleware/auth.middleware.js');
const { requirePlatformOwner, requireWorkspacePermission } = await import(
  '../src/middleware/authorization.middleware.js'
);
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { PERMISSIONS, hasPermission } = await import('../src/constants/permissions.js');
const { signToken } = await import('../src/utils/jwt.js');

const USER = { id: 'user-1', email: 'u@example.com' };
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';

const authHeader = (user: { id: string; email: string } = USER): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

// A throwaway app that exercises only the RBAC middleware, so the tests do not depend on
// the real route table (which gains the middleware in Checkpoint 4).
const buildApp = () => {
  const app = express();
  app.use(express.json());

  app.get('/platform/only', authenticate, requirePlatformOwner(), (_req, res) => {
    res.json({ success: true });
  });

  app.get(
    '/ws/:workspaceId/view',
    authenticate,
    requireWorkspacePermission(PERMISSIONS.WORKSPACE_VIEW),
    (req, res) => {
      res.json({ success: true, role: req.workspaceContext?.membership.role });
    }
  );

  app.delete(
    '/ws/:workspaceId',
    authenticate,
    requireWorkspacePermission(PERMISSIONS.WORKSPACE_DELETE),
    (_req, res) => {
      res.json({ success: true });
    }
  );

  app.post(
    '/bots/:botId/manage',
    authenticate,
    requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, { from: 'bot' }),
    (_req, res) => {
      res.json({ success: true });
    }
  );

  app.use(errorHandler);
  return app;
};

const app = buildApp();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hasPermission (role → permission matrix)', () => {
  it('grants OWNER workspace:delete and workspace:update', () => {
    expect(hasPermission('OWNER', PERMISSIONS.WORKSPACE_DELETE)).toBe(true);
    expect(hasPermission('OWNER', PERMISSIONS.WORKSPACE_UPDATE)).toBe(true);
    expect(hasPermission('OWNER', PERMISSIONS.MEMBERS_MANAGE)).toBe(true);
  });

  it('denies AGENT workspace:delete, bots:view and members:manage', () => {
    expect(hasPermission('AGENT', PERMISSIONS.WORKSPACE_DELETE)).toBe(false);
    expect(hasPermission('AGENT', PERMISSIONS.BOTS_VIEW)).toBe(false);
    expect(hasPermission('AGENT', PERMISSIONS.MEMBERS_MANAGE)).toBe(false);
  });

  it('grants AGENT the support permissions it needs', () => {
    expect(hasPermission('AGENT', PERMISSIONS.CONVERSATIONS_VIEW)).toBe(true);
    expect(hasPermission('AGENT', PERMISSIONS.CONVERSATIONS_REPLY)).toBe(true);
    expect(hasPermission('AGENT', PERMISSIONS.CONVERSATIONS_RESOLVE)).toBe(true);
    // …but not assignment or deletion (Checkpoint 7).
    expect(hasPermission('AGENT', PERMISSIONS.CONVERSATIONS_ASSIGN)).toBe(false);
    expect(hasPermission('AGENT', PERMISSIONS.CONVERSATIONS_MANAGE)).toBe(false);
  });

  it('keeps ADMIN below OWNER on member/workspace management', () => {
    expect(hasPermission('ADMIN', PERMISSIONS.MEMBERS_VIEW)).toBe(true);
    expect(hasPermission('ADMIN', PERMISSIONS.MEMBERS_MANAGE)).toBe(false);
    expect(hasPermission('ADMIN', PERMISSIONS.WORKSPACE_DELETE)).toBe(false);
    expect(hasPermission('ADMIN', PERMISSIONS.WORKSPACE_UPDATE)).toBe(false);
    expect(hasPermission('ADMIN', PERMISSIONS.BOTS_MANAGE)).toBe(true);
  });

  it('never grants platform permissions to workspace roles', () => {
    for (const role of ['OWNER', 'ADMIN', 'AGENT'] as const) {
      expect(hasPermission(role, PERMISSIONS.AI_OPERATE)).toBe(false);
      expect(hasPermission(role, PERMISSIONS.PLATFORM_ADMIN)).toBe(false);
    }
  });
});

describe('requirePlatformOwner', () => {
  it('rejects an authenticated non-owner with 403', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ platformRole: 'USER' });

    const res = await request(app).get('/platform/only').set('Authorization', authHeader());

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('allows a PLATFORM_OWNER', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ platformRole: 'PLATFORM_OWNER' });

    const res = await request(app).get('/platform/only').set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects an unauthenticated request with 401 (before the role check)', async () => {
    const res = await request(app).get('/platform/only');

    expect(res.status).toBe(401);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('requireWorkspacePermission', () => {
  it('returns 404 (not 403) when the caller is not a member — no tenant existence leak', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/ws/${WORKSPACE_ID}/view`)
      .set('Authorization', authHeader());

    expect(res.status).toBe(404);
  });

  it('returns 403 when a member lacks the permission', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue({
      id: 'm1',
      userId: USER.id,
      workspaceId: WORKSPACE_ID,
      role: 'AGENT',
    });

    const res = await request(app)
      .delete(`/ws/${WORKSPACE_ID}`)
      .set('Authorization', authHeader());

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('allows a member whose role grants the permission and attaches the context', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue({
      id: 'm1',
      userId: USER.id,
      workspaceId: WORKSPACE_ID,
      role: 'ADMIN',
    });

    const res = await request(app)
      .get(`/ws/${WORKSPACE_ID}/view`)
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('ADMIN');
  });

  it('resolves the workspace through the bot when scope is "bot"', async () => {
    prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
    prismaMock.workspaceMember.findUnique.mockResolvedValue({
      id: 'm1',
      userId: USER.id,
      workspaceId: WORKSPACE_ID,
      role: 'AGENT',
    });

    const res = await request(app)
      .post(`/bots/${BOT_ID}/manage`)
      .set('Authorization', authHeader());

    // AGENT resolves the workspace correctly, but cannot manage bots.
    expect(res.status).toBe(403);
    expect(prismaMock.bot.findUnique).toHaveBeenCalledWith({
      where: { id: BOT_ID },
      select: { workspaceId: true },
    });
  });

  it('returns 404 when the bot does not exist', async () => {
    prismaMock.bot.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/bots/${BOT_ID}/manage`)
      .set('Authorization', authHeader());

    expect(res.status).toBe(404);
  });
});
