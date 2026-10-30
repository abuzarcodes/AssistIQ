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
    $transaction: vi.fn((fn: any) => fn(mock)),
  };
  return mock;
});

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { default: app } = await import('../src/app.js');
const { signToken, signVisitorToken } = await import('../src/utils/jwt.js');
const {
  listDeployments,
  updateDeployment,
  getDeploymentSnippet,
  listDomains,
  addDomain,
  removeDomain,
  getPublishedConfig,
} = await import('../src/services/deployment.service.js');
const { startPublicConversation } = await import('../src/services/conversation.service.js');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const DEPLOYMENT_HOSTED_ID = '33333333-3333-3333-3333-333333333333';
const DEPLOYMENT_WIDGET_ID = '44444444-4444-4444-4444-444444444444';
const DEPLOYMENT_IFRAME_ID = '55555555-5555-5555-5555-555555555555';
const DOMAIN_ID = '66666666-6666-6666-6666-666666666666';
const CONV_ID = '77777777-7777-7777-7777-777777777777';

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock));

  // Default bot finding & workspace membership
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
});

describe('Phase 4: Deployment Management and Domain Restrictions (CP-4.1 to CP-4.13)', () => {
  const mockNow = new Date('2026-10-30T12:00:00Z');

  it('CP-4.1: listDeployments returns all deployments with status, format, slug, enabled, and domains', async () => {
    prismaMock.botDeployment.findMany.mockResolvedValueOnce([
      {
        id: DEPLOYMENT_HOSTED_ID,
        experienceId: 'exp-1',
        botId: BOT_ID,
        workspaceId: WORKSPACE_ID,
        format: 'HOSTED_PAGE',
        status: 'PUBLISHED',
        slug: 'support-chat',
        enabled: true,
        unpublishedAt: null,
        publishEpoch: 1,
        domains: [],
        createdAt: mockNow,
        updatedAt: mockNow,
      },
      {
        id: DEPLOYMENT_WIDGET_ID,
        experienceId: 'exp-1',
        botId: BOT_ID,
        workspaceId: WORKSPACE_ID,
        format: 'WIDGET',
        status: 'PUBLISHED',
        slug: null,
        enabled: true,
        unpublishedAt: null,
        publishEpoch: 1,
        domains: [{ id: DOMAIN_ID, domain: 'example.com', createdAt: mockNow }],
        createdAt: mockNow,
        updatedAt: mockNow,
      },
    ]);

    const result = await listDeployments(BOT_ID, USER_ID);

    expect(result).toHaveLength(2);
    expect(result[0].format).toBe('HOSTED_PAGE');
    expect(result[0].slug).toBe('support-chat');
    expect(result[1].format).toBe('WIDGET');
    expect(result[1].domains[0].domain).toBe('example.com');
  });

  it('CP-4.2 & CP-4.10: updateDeployment updates enabled state, validates slug format and uniqueness, and handles optimistic concurrency', async () => {
    prismaMock.botDeployment.findUnique.mockResolvedValue({
      id: DEPLOYMENT_HOSTED_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      format: 'HOSTED_PAGE',
      status: 'PUBLISHED',
      slug: 'old-slug',
      enabled: true,
      experience: { version: 2 },
      domains: [],
      createdAt: mockNow,
      updatedAt: mockNow,
    });

    // 1. Optimistic concurrency conflict on expectedVersion mismatch
    await expect(
      updateDeployment(DEPLOYMENT_HOSTED_ID, USER_ID, {
        enabled: false,
        expectedVersion: 1, // current is 2
      })
    ).rejects.toMatchObject({
      statusCode: 409,
    });

    // 2. Slug validation: format rejects invalid characters/lengths
    await expect(
      updateDeployment(DEPLOYMENT_HOSTED_ID, USER_ID, {
        slug: 'ab', // < 3 chars
      })
    ).rejects.toMatchObject({
      statusCode: 400,
    });

    await expect(
      updateDeployment(DEPLOYMENT_HOSTED_ID, USER_ID, {
        slug: 'Invalid_Slug!', // uppercase & symbols
      })
    ).rejects.toMatchObject({
      statusCode: 400,
    });

    // 3. Duplicate slug check returns 409
    prismaMock.botDeployment.findFirst.mockResolvedValueOnce({
      id: 'other-deployment',
      slug: 'taken-slug',
    });

    await expect(
      updateDeployment(DEPLOYMENT_HOSTED_ID, USER_ID, {
        slug: 'taken-slug',
      })
    ).rejects.toMatchObject({
      statusCode: 409,
    });

    // 4. Valid update succeeds
    prismaMock.botDeployment.findFirst.mockResolvedValueOnce(null);
    prismaMock.botDeployment.update.mockResolvedValueOnce({
      id: DEPLOYMENT_HOSTED_ID,
      experienceId: 'exp-1',
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      format: 'HOSTED_PAGE',
      status: 'PUBLISHED',
      slug: 'new-valid-slug',
      enabled: true,
      unpublishedAt: null,
      publishEpoch: 1,
      domains: [],
      createdAt: mockNow,
      updatedAt: mockNow,
    });

    const updated = await updateDeployment(DEPLOYMENT_HOSTED_ID, USER_ID, {
      slug: 'new-valid-slug',
      expectedVersion: 2,
    });

    expect(updated.slug).toBe('new-valid-slug');
  });

  it('CP-4.3, CP-4.4, CP-4.5, CP-4.6: getDeploymentSnippet generates correct installation snippets for all 3 formats', async () => {
    // 1. WIDGET snippet
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_WIDGET_ID,
      botId: BOT_ID,
      format: 'WIDGET',
      experience: { iframeWidth: '100%', iframeHeight: '600px' },
    });
    const widgetSnippet = await getDeploymentSnippet(DEPLOYMENT_WIDGET_ID, USER_ID);
    expect(widgetSnippet.format).toBe('WIDGET');
    expect(widgetSnippet.snippet).toContain('<script src="');
    expect(widgetSnippet.snippet).toContain(`data-deployment-id="${DEPLOYMENT_WIDGET_ID}"`);
    expect(widgetSnippet.snippet).toContain('/widget/loader.js');

    // 2. IFRAME snippet
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_IFRAME_ID,
      botId: BOT_ID,
      format: 'IFRAME',
      experience: { iframeWidth: '450px', iframeHeight: '700px' },
    });
    const iframeSnippet = await getDeploymentSnippet(DEPLOYMENT_IFRAME_ID, USER_ID);
    expect(iframeSnippet.format).toBe('IFRAME');
    expect(iframeSnippet.snippet).toContain('<iframe');
    expect(iframeSnippet.snippet).toContain(`src="http://localhost:3000/chat/embed/${DEPLOYMENT_IFRAME_ID}"`);
    expect(iframeSnippet.snippet).toContain('width="450px"');
    expect(iframeSnippet.snippet).toContain('height="700px"');
    expect(iframeSnippet.snippet).toContain('allow="clipboard-write"');

    // 3. HOSTED_PAGE URL snippet
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_HOSTED_ID,
      botId: BOT_ID,
      format: 'HOSTED_PAGE',
      slug: 'my-brand-chat',
      experience: {},
    });
    const hostedSnippet = await getDeploymentSnippet(DEPLOYMENT_HOSTED_ID, USER_ID);
    expect(hostedSnippet.format).toBe('HOSTED_PAGE');
    expect(hostedSnippet.snippet).toBe('http://localhost:3000/chat/my-brand-chat');
    expect(hostedSnippet.url).toBe('http://localhost:3000/chat/my-brand-chat');
  });

  it('CP-4.7 & CP-4.11: Domain allowlist CRUD validates hostnames and ensures unique entries', async () => {
    prismaMock.botDeployment.findUnique.mockResolvedValue({
      id: DEPLOYMENT_WIDGET_ID,
      botId: BOT_ID,
    });

    // 1. Invalid domains rejected
    await expect(addDomain(DEPLOYMENT_WIDGET_ID, 'https://example.com', USER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(addDomain(DEPLOYMENT_WIDGET_ID, 'example.com/path', USER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(addDomain(DEPLOYMENT_WIDGET_ID, 'invalid domain', USER_ID)).rejects.toMatchObject({
      statusCode: 400,
    });

    // 2. Valid domain added
    prismaMock.deploymentDomain.findUnique.mockResolvedValueOnce(null);
    prismaMock.deploymentDomain.create.mockResolvedValueOnce({
      id: DOMAIN_ID,
      deploymentId: DEPLOYMENT_WIDGET_ID,
      domain: 'app.example.com',
      createdAt: mockNow,
    });

    const added = await addDomain(DEPLOYMENT_WIDGET_ID, 'App.Example.com ', USER_ID);
    expect(added.domain).toBe('app.example.com');
    expect(prismaMock.deploymentDomain.create).toHaveBeenCalledWith({
      data: {
        deploymentId: DEPLOYMENT_WIDGET_ID,
        domain: 'app.example.com',
      },
    });

    // 3. List domains
    prismaMock.deploymentDomain.findMany.mockResolvedValueOnce([
      { id: DOMAIN_ID, deploymentId: DEPLOYMENT_WIDGET_ID, domain: 'app.example.com', createdAt: mockNow },
    ]);
    const domains = await listDomains(DEPLOYMENT_WIDGET_ID, USER_ID);
    expect(domains).toHaveLength(1);
    expect(domains[0].domain).toBe('app.example.com');

    // 4. Remove domain
    prismaMock.deploymentDomain.findFirst.mockResolvedValueOnce({
      id: DOMAIN_ID,
      deploymentId: DEPLOYMENT_WIDGET_ID,
      domain: 'app.example.com',
    });
    prismaMock.deploymentDomain.delete.mockResolvedValueOnce({ id: DOMAIN_ID });

    const removeRes = await removeDomain(DEPLOYMENT_WIDGET_ID, 'app.example.com', USER_ID);
    expect(removeRes.success).toBe(true);
    expect(prismaMock.deploymentDomain.delete).toHaveBeenCalledWith({ where: { id: DOMAIN_ID } });
  });

  it('CP-4.8: getPublishedConfig returns allowedDomains array when configured', async () => {
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_WIDGET_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      format: 'WIDGET',
      status: 'PUBLISHED',
      slug: null,
      enabled: true,
      publishEpoch: 1,
      domains: [
        { domain: 'store.example.com' },
        { domain: 'checkout.example.com' },
      ],
      experience: {
        publishedVersion: { config: { displayName: 'Support' } },
        bot: { id: BOT_ID, name: 'Support Bot', isActive: true },
      },
    });

    const result = await getPublishedConfig(DEPLOYMENT_WIDGET_ID);
    expect(result).not.toBeNull();
    expect(result?.deployment.allowedDomains).toEqual(['store.example.com', 'checkout.example.com']);
  });

  it('CP-4.9: REST routes enforce RBAC permissions (bots:view vs bots:manage)', async () => {
    const token = signToken({ sub: USER_ID, email: 'admin@example.com' });

    // 1. GET /bots/:botId/deployments requires bots:view
    prismaMock.botDeployment.findMany.mockResolvedValueOnce([]);
    const listRes = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/deployments`)
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);

    // 2. GET /bots/:botId/deployments/:deploymentId/snippet requires bots:view
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_WIDGET_ID,
      botId: BOT_ID,
      format: 'WIDGET',
      experience: {},
    });
    const snippetRes = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/deployments/${DEPLOYMENT_WIDGET_ID}/snippet`)
      .set('Authorization', `Bearer ${token}`);
    expect(snippetRes.status).toBe(200);

    // 3. POST /bots/:botId/deployments/:deploymentId/domains requires bots:manage
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_WIDGET_ID,
      botId: BOT_ID,
    });
    prismaMock.deploymentDomain.findUnique.mockResolvedValueOnce(null);
    prismaMock.deploymentDomain.create.mockResolvedValueOnce({
      id: DOMAIN_ID,
      deploymentId: DEPLOYMENT_WIDGET_ID,
      domain: 'trusted.com',
      createdAt: mockNow,
    });
    const addDomainRes = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/deployments/${DEPLOYMENT_WIDGET_ID}/domains`)
      .set('Authorization', `Bearer ${token}`)
      .send({ domain: 'trusted.com' });
    expect(addDomainRes.status).toBe(201);

    // 4. AGENT role lacks bots:manage and gets 403 on write
    prismaMock.workspaceMember.findUnique.mockResolvedValueOnce({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: 'AGENT',
    });
    const agentWriteRes = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/deployments/${DEPLOYMENT_WIDGET_ID}/domains`)
      .set('Authorization', `Bearer ${token}`)
      .send({ domain: 'trusted.com' });
    expect(agentWriteRes.status).toBe(403);
  });

  it('CP-4.12: Deployment disable (enabled: false) blocks new sessions but does not revoke existing ones', async () => {
    // 1. Config returns null (404) for disabled deployment
    prismaMock.botDeployment.findUnique.mockResolvedValueOnce({
      id: DEPLOYMENT_HOSTED_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      format: 'HOSTED_PAGE',
      status: 'PUBLISHED',
      enabled: false, // Disabled
      experience: {
        publishedVersion: { config: {} },
        bot: { id: BOT_ID, name: 'Bot', isActive: true },
      },
    });
    const configRes = await getPublishedConfig(DEPLOYMENT_HOSTED_ID);
    expect(configRes).toBeNull();

    // 2. Creating a new conversation on disabled deployment fails with 404
    prismaMock.bot.findUnique.mockResolvedValue({
      id: BOT_ID,
      workspaceId: WORKSPACE_ID,
      isActive: true,
    });
    prismaMock.botDeployment.findFirst.mockResolvedValueOnce(null); // No enabled deployment
    await expect(startPublicConversation(BOT_ID, DEPLOYMENT_HOSTED_ID)).rejects.toMatchObject({
      statusCode: 404,
    });

    // 3. Existing visitor session continues successfully when deployment is disabled (status is still PUBLISHED)
    prismaMock.conversation.findUnique.mockResolvedValue({
      id: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      deploymentId: DEPLOYMENT_HOSTED_ID,
      status: 'ACTIVE',
      createdAt: mockNow,
      escalatedAt: null,
      resolvedAt: null,
      messages: [],
    });
    prismaMock.botDeployment.findUnique.mockResolvedValue({
      id: DEPLOYMENT_HOSTED_ID,
      status: 'PUBLISHED', // Published, but enabled: false
      enabled: false,
      publishEpoch: 2,
    });
    prismaMock.message.findMany.mockResolvedValue([]);

    const visitorToken = signVisitorToken({
      conversationId: CONV_ID,
      botId: BOT_ID,
      workspaceId: WORKSPACE_ID,
      publishEpoch: 2,
    });

    const sessionRes = await request(app)
      .get(`/api/v1/public/conversations/${CONV_ID}`)
      .set('Authorization', `Bearer ${visitorToken}`);

    // Must be 200 — existing sessions are NOT revoked by disabling
    expect(sessionRes.status).toBe(200);
  });
});
