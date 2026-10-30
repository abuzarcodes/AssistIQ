import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const prismaMock = vi.hoisted(() => {
  const mock: any = {
    user: { findUnique: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
    bot: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    conversation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    conversationEvent: {
      create: vi.fn(),
    },
    message: {
      findMany: vi.fn(),
    },
    botExperience: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    botExperienceVersion: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    botDeployment: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    deploymentDomain: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    deploymentEvent: {
      findFirst: vi.fn(),
      create: vi.fn(),
      groupBy: vi.fn(),
    },
    $transaction: vi.fn((fn: any) => fn(mock)),
  };
  return mock;
});

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { default: app } = await import('../src/app.js');
const { signToken, signVisitorToken } = await import('../src/utils/jwt.js');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AGENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const DEPLOYMENT_ID = '33333333-3333-3333-3333-333333333333';
const CONV_ID = '44444444-4444-4444-4444-444444444444';

const adminToken = signToken({ sub: USER_ID, email: 'admin@example.com' });
const agentToken = signToken({ sub: AGENT_ID, email: 'agent@example.com' });

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock));

  prismaMock.bot.findUnique.mockResolvedValue({
    id: BOT_ID,
    name: 'Support Bot',
    workspaceId: WORKSPACE_ID,
    isActive: true,
  });
  prismaMock.bot.findFirst.mockResolvedValue({
    id: BOT_ID,
    name: 'Support Bot',
    workspaceId: WORKSPACE_ID,
    isActive: true,
  });
});

describe('Phase 6: Backend Security, Tests, and Hardening (CP-6.1 to CP-6.8)', () => {
  const mockNow = new Date('2026-10-31T12:00:00Z');

  it('CP-6.1: RBAC enforcement denies AGENT role on all experience management routes (403)', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue({
      userId: AGENT_ID,
      workspaceId: WORKSPACE_ID,
      role: 'AGENT',
    });

    // 1. GET /experience -> 403 (lacks bots:view)
    const getRes = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/experience`)
      .set('Authorization', `Bearer ${agentToken}`);
    expect(getRes.status).toBe(403);

    // 2. PATCH /experience -> 403 (lacks bots:manage)
    const patchRes = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/experience`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ displayName: 'New Name' });
    expect(patchRes.status).toBe(403);

    // 3. POST /experience/publish -> 403 (lacks bots:manage)
    const pubRes = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/experience/publish`)
      .set('Authorization', `Bearer ${agentToken}`);
    expect(pubRes.status).toBe(403);

    // 4. POST /experience/unpublish -> 403 (lacks bots:manage)
    const unpubRes = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/experience/unpublish`)
      .set('Authorization', `Bearer ${agentToken}`);
    expect(unpubRes.status).toBe(403);

    // 5. GET /deployments -> 403 (lacks bots:view)
    const depRes = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/deployments`)
      .set('Authorization', `Bearer ${agentToken}`);
    expect(depRes.status).toBe(403);

    // 6. PATCH /deployments/:id -> 403 (lacks bots:manage)
    const depPatchRes = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/deployments/${DEPLOYMENT_ID}`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ enabled: false });
    expect(depPatchRes.status).toBe(403);
  });

  it('CP-6.2: Tenant isolation returns 404 for non-members (zero information leakage)', async () => {
    // Caller is NOT a member of WORKSPACE_ID
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/experience`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);

    const depRes = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/deployments`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(depRes.status).toBe(404);
  });

  it('CP-6.3 & CP-6.4: Full publish/unpublish/republish lifecycle with visitor token epoch invalidation', async () => {
    // Step 1: Visitor connects during initial publish (epoch 1)
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      deploymentId: DEPLOYMENT_ID,
      status: 'ACTIVE',
      createdAt: mockNow,
      escalatedAt: null,
      resolvedAt: null,
      messages: [],
    });
    prismaMock.message.findMany.mockResolvedValue([]);

    prismaMock.botDeployment.findUnique.mockResolvedValue({
      id: DEPLOYMENT_ID,
      status: 'PUBLISHED',
      enabled: true,
      publishEpoch: 1,
    });

    const tokenEpoch1 = signVisitorToken({
      conversationId: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      publishEpoch: 1,
    });

    const activeRes = await request(app)
      .get(`/api/v1/public/conversations/${CONV_ID}`)
      .set('Authorization', `Bearer ${tokenEpoch1}`);
    expect(activeRes.status).toBe(200);

    // Step 2: Unpublish occurs -> deployment is UNPUBLISHED, tokenEpoch1 returns 404
    prismaMock.botDeployment.findUnique.mockResolvedValue({
      id: DEPLOYMENT_ID,
      status: 'UNPUBLISHED',
      enabled: true,
      publishEpoch: 1,
    });

    const unpubRes = await request(app)
      .get(`/api/v1/public/conversations/${CONV_ID}`)
      .set('Authorization', `Bearer ${tokenEpoch1}`);
    expect(unpubRes.status).toBe(404);

    // Step 3: Republish occurs -> publishEpoch becomes 2. Token from epoch 1 remains 404!
    prismaMock.botDeployment.findUnique.mockResolvedValue({
      id: DEPLOYMENT_ID,
      status: 'PUBLISHED',
      enabled: true,
      publishEpoch: 2,
    });

    const staleRes = await request(app)
      .get(`/api/v1/public/conversations/${CONV_ID}`)
      .set('Authorization', `Bearer ${tokenEpoch1}`);
    expect(staleRes.status).toBe(404);

    // Step 4: Token minted for new epoch 2 succeeds
    const tokenEpoch2 = signVisitorToken({
      conversationId: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      publishEpoch: 2,
    });

    const newEpochRes = await request(app)
      .get(`/api/v1/public/conversations/${CONV_ID}`)
      .set('Authorization', `Bearer ${tokenEpoch2}`);
    expect(newEpochRes.status).toBe(200);
  });

  it('CP-6.5: Public rate limits reject excessive traffic with 429', async () => {
    prismaMock.botDeployment.findUnique.mockResolvedValue({
      id: DEPLOYMENT_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      format: 'WIDGET',
      status: 'PUBLISHED',
      enabled: true,
      publishEpoch: 1,
      experience: {
        publishedVersion: { config: { displayName: 'Support' } },
        bot: { id: BOT_ID, name: 'Support Bot', isActive: true },
      },
    });

    // Public config rate limiter is 60 requests/min.
    // We send requests and verify standard headers or 429 when budget is exceeded.
    const responses = await Promise.all(
      Array.from({ length: 65 }, () =>
        request(app).get(`/api/v1/public/deployments/${DEPLOYMENT_ID}/config`)
      )
    );

    const has429 = responses.some((r) => r.status === 429);
    expect(has429).toBe(true);
  });

  it('CP-6.6: Optimistic concurrency rejects stale version updates with 409 Conflict', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: 'ADMIN',
    });

    // Current version is 3
    prismaMock.botExperience.findUnique.mockResolvedValue({
      id: 'exp-1',
      botId: BOT_ID,
      version: 3,
      deployments: [],
      publishedVersion: null,
      createdAt: mockNow,
      updatedAt: mockNow,
    });

    // Client sends expectedVersion: 2 (stale)
    const conflictRes = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/experience`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        displayName: 'Stale Update',
        expectedVersion: 2,
      });

    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.success).toBe(false);
  });
});
