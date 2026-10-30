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
      update: vi.fn(),
    },
    botDeployment: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
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
const { signToken } = await import('../src/utils/jwt.js');
const {
  recordEvent,
  getDeploymentAnalytics,
  getWorkspaceAnalytics,
} = await import('../src/services/analytics.service.js');
const { startPublicConversation, resolveConversation } = await import(
  '../src/services/conversation.service.js'
);

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_WORKSPACE_ID = '99999999-9999-9999-9999-999999999999';
const DEPLOYMENT_ID = '33333333-3333-3333-3333-333333333333';
const CONV_ID = '44444444-4444-4444-4444-444444444444';

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
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: 'ADMIN',
  });
  prismaMock.botDeployment.findUnique.mockResolvedValue({
    id: DEPLOYMENT_ID,
    botId: BOT_ID,
    workspaceId: WORKSPACE_ID,
    format: 'WIDGET',
    status: 'PUBLISHED',
    enabled: true,
    publishEpoch: 1,
  });
});

describe('Phase 5: Analytics and Event Attribution (CP-5.1 to CP-5.9)', () => {
  const mockNow = new Date('2026-10-30T12:00:00Z');

  it('CP-5.1: recordEvent persists event with deployment, bot, and workspace attribution', async () => {
    prismaMock.deploymentEvent.create.mockResolvedValueOnce({
      id: 'event-1',
      deploymentId: DEPLOYMENT_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      eventType: 'chat_start',
      sessionId: 'sess-123',
      metadata: null,
      createdAt: mockNow,
    });

    const event = await recordEvent(DEPLOYMENT_ID, 'chat_start', 'sess-123');

    expect(prismaMock.deploymentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deploymentId: DEPLOYMENT_ID,
          botId: BOT_ID,
          workspaceId: WORKSPACE_ID,
          eventType: 'chat_start',
          sessionId: 'sess-123',
        }),
      })
    );
    expect(event?.id).toBe('event-1');
  });

  it('CP-5.2: startPublicConversation records conversation_created analytics event', async () => {
    prismaMock.botDeployment.findFirst.mockResolvedValueOnce({
      id: DEPLOYMENT_ID,
      publishEpoch: 1,
    });
    prismaMock.conversation.create.mockResolvedValueOnce({
      id: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      deploymentId: DEPLOYMENT_ID,
      visitorSessionHash: 'hash',
    });

    await startPublicConversation(BOT_ID, DEPLOYMENT_ID);

    expect(prismaMock.deploymentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deploymentId: DEPLOYMENT_ID,
          eventType: 'conversation_created',
          metadata: expect.objectContaining({ conversationId: CONV_ID }),
        }),
      })
    );
  });

  it('CP-5.3: conversation resolution records conversation_resolved and ai_resolved when resolved directly', async () => {
    prismaMock.conversation.findFirst.mockResolvedValueOnce({
      id: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      deploymentId: DEPLOYMENT_ID,
      status: 'ACTIVE',
      assignedAgentId: null,
      version: 1,
    });

    prismaMock.conversation.update.mockResolvedValueOnce({
      id: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      deploymentId: DEPLOYMENT_ID,
      status: 'RESOLVED',
      assignedAgentId: null,
      version: 2,
    });

    await resolveConversation(CONV_ID, WORKSPACE_ID, USER_ID);

    expect(prismaMock.deploymentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deploymentId: DEPLOYMENT_ID,
          eventType: 'conversation_resolved',
        }),
      })
    );

    expect(prismaMock.deploymentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deploymentId: DEPLOYMENT_ID,
          eventType: 'ai_resolved',
        }),
      })
    );
  });

  it('CP-5.4: POST /public/deployments/:deploymentId/events records client events', async () => {
    prismaMock.deploymentEvent.create.mockResolvedValueOnce({
      id: 'event-2',
      deploymentId: DEPLOYMENT_ID,
      eventType: 'chat_start',
      createdAt: mockNow,
    });

    const res = await request(app)
      .post(`/api/v1/public/deployments/${DEPLOYMENT_ID}/events`)
      .send({
        eventType: 'chat_start',
        sessionId: 'session-xyz',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.recorded).toBe(true);

    // Rejects invalid event types
    const badRes = await request(app)
      .post(`/api/v1/public/deployments/${DEPLOYMENT_ID}/events`)
      .send({
        eventType: 'arbitrary_event',
      });
    expect(badRes.status).toBe(400);
  });

  it('CP-5.5: getDeploymentAnalytics aggregates metrics into correct counts', async () => {
    prismaMock.deploymentEvent.groupBy.mockResolvedValueOnce([
      { eventType: 'page_view', _count: { _all: 120 } },
      { eventType: 'chat_start', _count: { _all: 45 } },
      { eventType: 'conversation_created', _count: { _all: 30 } },
      { eventType: 'ai_resolved', _count: { _all: 18 } },
      { eventType: 'human_handoff', _count: { _all: 12 } },
      { eventType: 'conversation_resolved', _count: { _all: 28 } },
    ]);

    const result = await getDeploymentAnalytics(DEPLOYMENT_ID, USER_ID);

    expect(result.deploymentId).toBe(DEPLOYMENT_ID);
    expect(result.metrics.pageViews).toBe(120);
    expect(result.metrics.chatStarts).toBe(45);
    expect(result.metrics.conversationsCreated).toBe(30);
    expect(result.metrics.aiResolved).toBe(18);
    expect(result.metrics.humanHandoff).toBe(12);
    expect(result.metrics.conversationsResolved).toBe(28);
  });

  it('CP-5.6: getWorkspaceAnalytics aggregates per-deployment breakdowns and totals', async () => {
    prismaMock.botDeployment.findMany.mockResolvedValueOnce([
      { id: DEPLOYMENT_ID, format: 'WIDGET', botId: BOT_ID },
      { id: 'dep-hosted', format: 'HOSTED_PAGE', botId: BOT_ID },
    ]);

    prismaMock.deploymentEvent.groupBy.mockResolvedValueOnce([
      { deploymentId: DEPLOYMENT_ID, eventType: 'page_view', _count: { _all: 50 } },
      { deploymentId: DEPLOYMENT_ID, eventType: 'conversation_created', _count: { _all: 10 } },
      { deploymentId: 'dep-hosted', eventType: 'page_view', _count: { _all: 30 } },
      { deploymentId: 'dep-hosted', eventType: 'conversation_created', _count: { _all: 5 } },
    ]);

    const result = await getWorkspaceAnalytics(WORKSPACE_ID, USER_ID);

    expect(result.workspaceId).toBe(WORKSPACE_ID);
    expect(result.deployments).toHaveLength(2);
    expect(result.totals.pageViews).toBe(80);
    expect(result.totals.conversationsCreated).toBe(15);
  });

  it('CP-5.7: Preview/test conversations without deploymentId produce no analytics events', async () => {
    // A internal dashboard-created conversation has no deploymentId
    prismaMock.conversation.findFirst.mockResolvedValueOnce({
      id: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      deploymentId: null, // No deployment
      status: 'ACTIVE',
      assignedAgentId: null,
      version: 1,
    });

    prismaMock.conversation.update.mockResolvedValueOnce({
      id: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      deploymentId: null,
      status: 'RESOLVED',
      assignedAgentId: null,
      version: 2,
    });

    await resolveConversation(CONV_ID, WORKSPACE_ID, USER_ID);

    expect(prismaMock.deploymentEvent.create).not.toHaveBeenCalled();
  });

  it('CP-5.8: page_view events with same sessionId within 30 minutes are deduplicated', async () => {
    // Recent event exists within 30 minutes
    const existingRecent = {
      id: 'existing-event',
      deploymentId: DEPLOYMENT_ID,
      eventType: 'page_view',
      sessionId: 'sess-dup',
      createdAt: new Date(),
    };
    prismaMock.deploymentEvent.findFirst.mockResolvedValueOnce(existingRecent);

    const result = await recordEvent(DEPLOYMENT_ID, 'page_view', 'sess-dup');

    expect(result?.id).toBe('existing-event');
    expect(prismaMock.deploymentEvent.create).not.toHaveBeenCalled();
  });

  it('CP-5.9: Tenant isolation: cross-workspace access to analytics is denied', async () => {
    const token = signToken({ sub: USER_ID, email: 'admin@example.com' });

    // User is NOT a member of OTHER_WORKSPACE_ID
    prismaMock.workspaceMember.findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .get(`/api/v1/workspaces/${OTHER_WORKSPACE_ID}/analytics/deployments`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
