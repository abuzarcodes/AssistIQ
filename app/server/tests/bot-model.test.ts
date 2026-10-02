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
  aIProvider: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  aIModel: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  conversation: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  message: { create: vi.fn() },
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const OWNER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'owner@example.com' };
const AGENT = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'agent@example.com' };

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const MODEL_ID = '33333333-3333-3333-3333-333333333333';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

const membership = (userId: string, role: 'OWNER' | 'ADMIN' | 'AGENT') =>
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'member-1',
    userId,
    workspaceId: WORKSPACE_ID,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

/**
 * Arrange the world for one `PATCH /bots/:botId/model` call.
 *
 * The order matters and is the point: the permission middleware resolves `:botId` to a
 * workspace through `bot.findUnique` *before* it looks up the caller's membership. Leaving
 * that unprimed makes every request 404 at scope resolution, which would mask whatever the
 * test actually meant to exercise.
 */
const arrangePatch = (userId: string, role: 'OWNER' | 'ADMIN' | 'AGENT') => {
  prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
  membership(userId, role);
  prismaMock.bot.findFirst.mockResolvedValue(botRow());
};

/** The bot as `getBotById` returns it — membership-scoped, with its model included. */
const botRow = (aiModel: Record<string, unknown> | null = null) => ({
  id: BOT_ID,
  name: 'Helper',
  description: null,
  workspaceId: WORKSPACE_ID,
  aiModelId: aiModel ? MODEL_ID : null,
  createdAt: new Date(),
  updatedAt: new Date(),
  aiModel,
});

const modelRow = (overrides: Record<string, unknown> = {}) => ({
  id: MODEL_ID,
  displayName: 'GPT-4o mini',
  enabled: true,
  provider: { slug: 'openrouter', name: 'OpenRouter', enabled: true },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------------------
// PATCH /api/v1/bots/:botId/model
// ---------------------------------------------------------------------------------------

describe('PATCH /api/v1/bots/:botId/model', () => {
  it('assigns an enabled model from an enabled provider (200)', async () => {
    arrangePatch(OWNER.id, 'OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID, enabled: true, provider: { enabled: true } });
    prismaMock.bot.update.mockResolvedValue(botRow(modelRow()));

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/model`)
      .set('Authorization', authHeader(OWNER))
      .send({ aiModelId: MODEL_ID });

    expect(res.status).toBe(200);
    expect(res.body.data.aiModelId).toBe(MODEL_ID);
    expect(prismaMock.bot.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: BOT_ID }, data: { aiModelId: MODEL_ID } })
    );
  });

  it('clears the assignment with null — the "platform default" state (200)', async () => {
    membership(OWNER.id, 'OWNER');
    prismaMock.bot.findFirst.mockResolvedValue(botRow(modelRow()));
    prismaMock.bot.update.mockResolvedValue(botRow(null));

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/model`)
      .set('Authorization', authHeader(OWNER))
      .send({ aiModelId: null });

    expect(res.status).toBe(200);
    expect(res.body.data.aiModelId).toBeNull();
    expect(res.body.data.aiModel).toBeNull();
    // Clearing is always permitted and never validates a model.
    expect(prismaMock.aIModel.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.bot.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { aiModelId: null } })
    );
  });

  it('rejects an unknown model with 400, not 404 — the caller is a verified member', async () => {
    arrangePatch(OWNER.id, 'OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/model`)
      .set('Authorization', authHeader(OWNER))
      .send({ aiModelId: MODEL_ID });

    expect(res.status).toBe(400);
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('rejects a disabled model with 400', async () => {
    arrangePatch(OWNER.id, 'OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID, enabled: false, provider: { enabled: true } });

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/model`)
      .set('Authorization', authHeader(OWNER))
      .send({ aiModelId: MODEL_ID });

    expect(res.status).toBe(400);
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('rejects a model whose provider is disabled with 400', async () => {
    arrangePatch(OWNER.id, 'OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID, enabled: true, provider: { enabled: false } });

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/model`)
      .set('Authorization', authHeader(OWNER))
      .send({ aiModelId: MODEL_ID });

    expect(res.status).toBe(400);
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('the catalog-bypass guard: a provider-native model id is 400 and writes nothing', async () => {
    arrangePatch(OWNER.id, 'OWNER');

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/model`)
      .set('Authorization', authHeader(OWNER))
      // A client attempting to name the provider's model directly instead of a catalog uuid.
      .send({ aiModelId: 'openai/gpt-4o-mini' });

    expect(res.status).toBe(400);
    // Rejected by schema validation, so the service — and the catalog — was never consulted.
    expect(prismaMock.aIModel.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('an AGENT is denied with 403 and writes nothing', async () => {
    arrangePatch(AGENT.id, 'AGENT');

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/model`)
      .set('Authorization', authHeader(AGENT))
      .send({ aiModelId: MODEL_ID });

    expect(res.status).toBe(403);
    expect(prismaMock.aIModel.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('a non-member gets 404 and cannot probe the catalog', async () => {
    // The bot resolves to a real workspace; it is the *membership* that is absent, which is
    // what makes this a 404 rather than a 403.
    prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/model`)
      .set('Authorization', authHeader(AGENT))
      .send({ aiModelId: MODEL_ID });

    expect(res.status).toBe(404);
    expect(prismaMock.aIModel.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });

  it('rejects a body with no aiModelId key (400) — an omission is not a clear', async () => {
    arrangePatch(OWNER.id, 'OWNER');

    const res = await request(app)
      .patch(`/api/v1/bots/${BOT_ID}/model`)
      .set('Authorization', authHeader(OWNER))
      .send({});

    // `null` means "platform default"; a *missing* key is an incomplete request, and
    // treating it as a clear would silently unassign a bot on a malformed call.
    expect(res.status).toBe(400);
    expect(prismaMock.bot.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// GET /api/v1/ai/models — the workspace-facing catalog read
// ---------------------------------------------------------------------------------------

describe('GET /api/v1/ai/models', () => {
  it('returns enabled models of enabled providers, and no provider-native id', async () => {
    prismaMock.aIModel.findMany.mockResolvedValue([
      { id: MODEL_ID, displayName: 'GPT-4o mini', provider: { slug: 'openrouter', name: 'OpenRouter' } },
    ]);

    const res = await request(app)
      .get('/api/v1/ai/models')
      .set('Authorization', authHeader(AGENT));

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual({
      id: MODEL_ID,
      displayName: 'GPT-4o mini',
      provider: { slug: 'openrouter', name: 'OpenRouter' },
    });
    // The projection is what makes the bypass impossible rather than merely discouraged.
    expect(JSON.stringify(res.body.data)).not.toContain('providerModelId');
    expect(JSON.stringify(res.body.data)).not.toContain('gpt-4o-mini');
  });

  it('filters in the query: only enabled models of enabled providers', async () => {
    prismaMock.aIModel.findMany.mockResolvedValue([]);

    await request(app).get('/api/v1/ai/models').set('Authorization', authHeader(AGENT));

    expect(prismaMock.aIModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { enabled: true, provider: { enabled: true } } })
    );
  });

  it('requires authentication (401)', async () => {
    const res = await request(app).get('/api/v1/ai/models');
    expect(res.status).toBe(401);
    expect(prismaMock.aIModel.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// Bot read projections must not leak the provider-native id anywhere
// ---------------------------------------------------------------------------------------

describe('bot read projections never expose providerModelId', () => {
  it('GET /bots/:botId omits providerModelId while including the model label', async () => {
    membership(OWNER.id, 'OWNER');
    prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
    prismaMock.bot.findFirst.mockResolvedValue(botRow(modelRow()));

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}`)
      .set('Authorization', authHeader(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.data.aiModel.displayName).toBe('GPT-4o mini');
    expect(res.body.data.aiModel.provider.slug).toBe('openrouter');
    expect(JSON.stringify(res.body.data)).not.toContain('providerModelId');

    // The projection is pinned at the query level too — the column is never even read.
    const call = prismaMock.bot.findFirst.mock.calls[0][0] as { include?: unknown };
    expect(JSON.stringify(call.include)).not.toContain('providerModelId');
  });

  it('the bot list omits providerModelId as well', async () => {
    membership(OWNER.id, 'OWNER');
    // The service re-scopes through `getWorkspaceById` (defence in depth behind the
    // middleware), so this read is required for the list to resolve at all.
    prismaMock.workspace.findFirst.mockResolvedValue({ id: WORKSPACE_ID, ownerId: OWNER.id });
    prismaMock.bot.findMany.mockResolvedValue([botRow(modelRow())]);

    const res = await request(app)
      .get(`/api/v1/workspaces/${WORKSPACE_ID}/bots`)
      .set('Authorization', authHeader(OWNER));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.data)).not.toContain('providerModelId');
  });
});
