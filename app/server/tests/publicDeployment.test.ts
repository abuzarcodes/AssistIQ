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
      updateMany: vi.fn(),
    },
    $transaction: vi.fn((fn: any) => fn(mock)),
  };
  return mock;
});

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { default: app } = await import('../src/app.js');
const { signToken, signVisitorToken, verifyVisitorToken } = await import('../src/utils/jwt.js');
const { getPublishedConfig, getPublishedConfigBySlug } = await import('../src/services/deployment.service.js');
const { startPublicConversation } = await import('../src/services/conversation.service.js');
const { evictBotVisitorSockets } = await import('../src/realtime/socketServer.js');
const { setSocketServer } = await import('../src/realtime/events.js');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const DEPLOYMENT_ID = '44444444-4444-4444-4444-444444444444';
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const CONV_ID = '55555555-5555-5555-5555-555555555555';

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock));
});

describe('Phase 3: Public Deployment Access and Visitor Sessions (CP-3.1 to CP-3.11)', () => {
  const publishedSnapshot = {
    displayName: 'Live Public Assistant',
    botAvatarUrl: 'https://example.com/bot.png',
    businessLogoUrl: null,
    accentColor: '#4f46e5',
    userBubbleColor: null,
    botBubbleColor: null,
    themeMode: 'system',
    themePreset: 'professional',
    hostedPageTitle: 'Live Support',
    hostedPageDescription: 'Ask us anything',
    widgetPosition: 'bottom-right',
    widgetLauncherLabel: 'Chat',
    widgetPanelWidth: 400,
    widgetPanelHeight: 600,
    widgetMobileBehavior: 'fullscreen',
    iframeWidth: '100%',
    iframeHeight: '600px',
    welcomeMessage: 'Welcome to our service!',
    welcomeSubtitle: null,
    inputPlaceholder: 'Type a message...',
    suggestedQuestions: ['How can I help?'],
    firstOpenBehavior: 'welcome',
    showTimestamps: true,
    autoOpen: false,
    privacyPolicyUrl: null,
    termsUrl: null,
    showBranding: true,
  };

  it('CP-3.1: getPublishedConfig returns config for PUBLISHED enabled deployment, null for others', async () => {
    // 1. PUBLISHED and enabled -> returns config
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      format: 'WIDGET',
      status: 'PUBLISHED',
      enabled: true,
      slug: null,
      publishEpoch: 1,
      experience: {
        publishedVersion: { config: publishedSnapshot },
        bot: { id: BOT_ID, name: 'Support Bot', isActive: true },
      },
    });

    const config = await getPublishedConfig(DEPLOYMENT_ID);
    expect(config).not.toBeNull();
    expect(config?.deployment.id).toBe(DEPLOYMENT_ID);
    expect(config?.config.displayName).toBe('Live Public Assistant');

    // 2. UNPUBLISHED -> returns null
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_ID,
      status: 'UNPUBLISHED',
      enabled: true,
      experience: { publishedVersion: { config: publishedSnapshot }, bot: { id: BOT_ID, isActive: true } },
    });
    expect(await getPublishedConfig(DEPLOYMENT_ID)).toBeNull();

    // 3. Disabled -> returns null
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_ID,
      status: 'PUBLISHED',
      enabled: false,
      experience: { publishedVersion: { config: publishedSnapshot }, bot: { id: BOT_ID, isActive: true } },
    });
    expect(await getPublishedConfig(DEPLOYMENT_ID)).toBeNull();

    // 4. Inactive bot -> returns null
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_ID,
      status: 'PUBLISHED',
      enabled: true,
      experience: { publishedVersion: { config: publishedSnapshot }, bot: { id: BOT_ID, isActive: false } },
    });
    expect(await getPublishedConfig(DEPLOYMENT_ID)).toBeNull();
  });

  it('CP-3.2: GET /api/v1/public/deployments/:deploymentId/config returns published config or 404', async () => {
    // 200 for published deployment
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      format: 'WIDGET',
      status: 'PUBLISHED',
      enabled: true,
      slug: null,
      publishEpoch: 0,
      experience: {
        publishedVersion: { config: publishedSnapshot },
        bot: { id: BOT_ID, name: 'Support Bot', isActive: true },
      },
    });

    const res = await request(app).get(`/api/v1/public/deployments/${DEPLOYMENT_ID}/config`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.config.displayName).toBe('Live Public Assistant');

    // 404 for unpublished deployment
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce(null);
    const notFound = await request(app).get(`/api/v1/public/deployments/${DEPLOYMENT_ID}/config`);
    expect(notFound.status).toBe(404);
  });

  it('CP-3.3: GET /api/v1/public/deployments/slug/:slug/config resolves slug and returns config', async () => {
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      format: 'HOSTED_PAGE',
      status: 'PUBLISHED',
      enabled: true,
      slug: 'my-bot-slug-123456',
      publishEpoch: 0,
      experience: {
        publishedVersion: { config: publishedSnapshot },
        bot: { id: BOT_ID, name: 'Support Bot', isActive: true },
      },
    });

    const res = await request(app).get('/api/v1/public/deployments/slug/my-bot-slug-123456/config');
    expect(res.status).toBe(200);
    expect(res.body.data.deployment.slug).toBe('my-bot-slug-123456');
    expect(res.body.data.config.welcomeMessage).toBe('Welcome to our service!');
  });

  it('CP-3.4: startPublicConversation returns 404 on an unpublished bot', async () => {
    prismaMock.bot.findUnique.mockResolvedValue({
      id: BOT_ID,
      workspaceId: WORKSPACE_ID,
      isActive: true,
    });
    // No published deployment exists
    prismaMock.botDeployment.findFirst.mockResolvedValue(null);

    await expect(startPublicConversation(BOT_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('CP-3.5: startPublicConversation sets deploymentId and attributes conversation to deployment', async () => {
    prismaMock.bot.findUnique.mockResolvedValue({
      id: BOT_ID,
      workspaceId: WORKSPACE_ID,
      isActive: true,
    });
    prismaMock.botDeployment.findFirst.mockResolvedValue({
      id: DEPLOYMENT_ID,
      publishEpoch: 3,
    });
    prismaMock.conversation.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: CONV_ID,
        ...data,
      })
    );

    const result = await startPublicConversation(BOT_ID, DEPLOYMENT_ID);

    expect(prismaMock.conversation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        botId: BOT_ID,
        workspaceId: WORKSPACE_ID,
        deploymentId: DEPLOYMENT_ID,
      }),
    });
    expect(result.conversation.deploymentId).toBe(DEPLOYMENT_ID);
  });

  it('CP-3.6: visitor JWT includes publishEpoch claim', () => {
    const token = signVisitorToken({
      conversationId: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      publishEpoch: 5,
    });

    const payload = verifyVisitorToken(token);
    expect(payload.publishEpoch).toBe(5);
  });

  it('CP-3.7 & CP-3.9: authenticateVisitor rejects token with stale publishEpoch', async () => {
    // Current deployment is epoch 2
    prismaMock.botDeployment.findUnique.mockResolvedValue({
      id: DEPLOYMENT_ID,
      status: 'PUBLISHED',
      enabled: true,
      publishEpoch: 2,
    });

    prismaMock.conversation.findUnique.mockResolvedValue({
      id: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      deploymentId: DEPLOYMENT_ID,
    });

    // Token was minted with epoch 1 (before unpublish)
    const staleToken = signVisitorToken({
      conversationId: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      publishEpoch: 1,
    });

    // Try to access conversation with stale token
    const res = await request(app)
      .get(`/api/v1/public/conversations/${CONV_ID}`)
      .set('Authorization', `Bearer ${staleToken}`);

    // Stale epoch must result in 404
    expect(res.status).toBe(404);

    // Token with matching epoch 2 succeeds (returns 200 or conversation data)
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      deploymentId: DEPLOYMENT_ID,
      status: 'ACTIVE',
      createdAt: new Date(),
      escalatedAt: null,
      resolvedAt: null,
      messages: [],
    });
    prismaMock.message.findMany.mockResolvedValue([]);

    const validToken = signVisitorToken({
      conversationId: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      publishEpoch: 2,
    });

    const validRes = await request(app)
      .get(`/api/v1/public/conversations/${CONV_ID}`)
      .set('Authorization', `Bearer ${validToken}`);

    expect(validRes.status).toBe(200);
  });

  it('CP-3.8: evictBotVisitorSockets disconnects all visitor sockets for the bot', async () => {
    const mockSocketVisitorMatching = {
      data: {
        subscriptions: {
          principal: { kind: 'visitor', botId: BOT_ID, conversationId: CONV_ID },
          rooms: new Map([['room1', 'ws-1']]),
        },
      },
      leave: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };

    const mockSocketVisitorOtherBot = {
      data: {
        subscriptions: {
          principal: { kind: 'visitor', botId: 'other-bot', conversationId: 'other-conv' },
          rooms: new Map(),
        },
      },
      leave: vi.fn(),
      disconnect: vi.fn(),
    };

    const mockSocketAgent = {
      data: {
        subscriptions: {
          principal: { kind: 'agent', userId: USER_ID },
          rooms: new Map(),
        },
      },
      leave: vi.fn(),
      disconnect: vi.fn(),
    };

    const mockIo: any = {
      fetchSockets: vi.fn().mockResolvedValue([
        mockSocketVisitorMatching,
        mockSocketVisitorOtherBot,
        mockSocketAgent,
      ]),
    };

    setSocketServer(mockIo);

    const evictedCount = await evictBotVisitorSockets(BOT_ID);

    expect(evictedCount).toBe(1);
    expect(mockSocketVisitorMatching.disconnect).toHaveBeenCalledWith(true);
    expect(mockSocketVisitorOtherBot.disconnect).not.toHaveBeenCalled();
    expect(mockSocketAgent.disconnect).not.toHaveBeenCalled();

    setSocketServer(null);
  });

  it('CP-3.10: unpublish revokes visitor token, while agent still accesses conversation via internal RBAC', async () => {
    // 1. Visitor token check against UNPUBLISHED deployment returns 404
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      deploymentId: DEPLOYMENT_ID,
      bot: { workspaceId: WORKSPACE_ID },
    });
    prismaMock.botDeployment.findUnique.mockResolvedValue({
      id: DEPLOYMENT_ID,
      status: 'UNPUBLISHED',
      enabled: true,
      publishEpoch: 1,
    });

    const visitorToken = signVisitorToken({
      conversationId: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      publishEpoch: 0,
    });

    const visitorRes = await request(app)
      .get(`/api/v1/public/conversations/${CONV_ID}`)
      .set('Authorization', `Bearer ${visitorToken}`);

    expect(visitorRes.status).toBe(404);

    // 2. Agent token reading through /api/v1/conversations/:id still succeeds via RBAC
    prismaMock.bot.findUnique.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
    });
    prismaMock.workspaceMember.findUnique.mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: 'AGENT',
    });
    prismaMock.conversation.findFirst.mockResolvedValue({
      id: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      status: 'ACTIVE',
      messages: [],
      assignedAgentId: null,
      events: [],
      contact: null,
    });

    const agentToken = signToken({ sub: USER_ID, email: 'agent@example.com' });
    const agentRes = await request(app)
      .get(`/api/v1/conversations/${CONV_ID}`)
      .set('Authorization', `Bearer ${agentToken}`);

    expect(agentRes.status).toBe(200);
  });
});
