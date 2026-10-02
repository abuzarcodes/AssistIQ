import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  workspace: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  aIProvider: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  aIModel: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Only the AI status call is mocked. No provider SDK is imported anywhere in the server, so
// there is nothing else that *could* reach a provider — the "no outbound request" assertion
// below pins that by checking this mock is the only outbound seam used.
const aiMock = vi.hoisted(() => ({ getAiStatus: vi.fn() }));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');
const { logger } = await import('../src/config/logger.js');

/**
 * The real Pino logger, silenced and with `info` spied, so the catalog's attribution
 * records (S10) can be asserted on.
 *
 * Spying rather than replacing the module is deliberate: pino-http builds a per-request
 * *child* logger, and a child gets its own `info`. So request logging never lands on this
 * spy and "exactly one record per change" is a statement about the catalog's own records
 * rather than about how many HTTP requests the test happened to make.
 */
logger.level = 'silent';
const infoSpy = vi.spyOn(logger, 'info');

const PLATFORM_USER = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', email: 'platform@example.com' };
const NORMAL_USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'user@example.com' };

const PROVIDER_ID = '11111111-1111-1111-1111-111111111111';
const MODEL_ID = '22222222-2222-2222-2222-222222222222';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

const setPlatformRole = (role: 'USER' | 'PLATFORM_OWNER'): void => {
  prismaMock.user.findUnique.mockResolvedValue({ id: PLATFORM_USER.id, platformRole: role });
};

const providerRow = (overrides: Record<string, unknown> = {}) => ({
  id: PROVIDER_ID,
  slug: 'openrouter',
  name: 'OpenRouter',
  description: 'Multi-vendor model gateway (OpenAI-compatible).',
  enabled: false,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
  models: [],
  ...overrides,
});

const modelRow = (overrides: Record<string, unknown> = {}) => ({
  id: MODEL_ID,
  providerId: PROVIDER_ID,
  providerModelId: 'openai/gpt-4o-mini',
  displayName: 'GPT-4o mini',
  enabled: false,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
  provider: { id: PROVIDER_ID, slug: 'openrouter', name: 'OpenRouter', enabled: false },
  _count: { bots: 0 },
  ...overrides,
});

/** Every write mock, so a rejected request can be proven to have written nothing. */
const writeMocks = () => [
  prismaMock.aIProvider.update,
  prismaMock.aIModel.create,
  prismaMock.aIModel.update,
  prismaMock.aIModel.delete,
];

const expectNoWrites = (): void => {
  for (const mock of writeMocks()) {
    expect(mock).not.toHaveBeenCalled();
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the AI service answers, but reports no `provider_adapters` (the shape before
  // Checkpoint 5 lands). Readiness is then "unknown" — never an affirmative `false`.
  aiMock.getAiStatus.mockResolvedValue({ service: 'assistiq-ai', status: 'operational' });
});

// ---------------------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------------------

describe('AI catalog — authorization', () => {
  const routes: Array<[string, string]> = [
    ['get', '/api/v1/platform/providers'],
    ['patch', `/api/v1/platform/providers/${PROVIDER_ID}`],
    ['get', '/api/v1/platform/models'],
    ['post', '/api/v1/platform/models'],
    ['patch', `/api/v1/platform/models/${MODEL_ID}`],
    ['delete', `/api/v1/platform/models/${MODEL_ID}`],
  ];

  it.each(routes)('unauthenticated %s %s is 401', async (method, path) => {
    const res = await (request(app) as never as Record<string, Function>)[method](path);

    expect(res.status).toBe(401);
    expect(aiMock.getAiStatus).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each(routes)('a non-platform-owner gets 403 on %s %s', async (method, path) => {
    setPlatformRole('USER');

    const res = await (request(app) as never as Record<string, Function>)[method](path)
      .set('Authorization', authHeader(NORMAL_USER))
      .send({});

    expect(res.status).toBe(403);
    expect(aiMock.getAiStatus).not.toHaveBeenCalled();
    expectNoWrites();
  });
});

// ---------------------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------------------

describe('GET /api/v1/platform/providers', () => {
  it('returns providers with model counts (200)', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findMany.mockResolvedValue([
      providerRow({ models: [{ enabled: true }, { enabled: false }, { enabled: true }] }),
    ]);

    const res = await request(app)
      .get('/api/v1/platform/providers')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      slug: 'openrouter',
      modelCount: 3,
      enabledModelCount: 2,
    });
  });

  it('reports BOTH readiness fields, never a reachability field', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findMany.mockResolvedValue([providerRow()]);
    aiMock.getAiStatus.mockResolvedValue({
      status: 'operational',
      provider_adapters: [{ slug: 'openrouter', configured: true }],
    });

    const res = await request(app)
      .get('/api/v1/platform/providers')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(200);
    expect(res.body.data[0].adapterAvailable).toBe(true);
    expect(res.body.data[0].credentialConfigured).toBe(true);
    // Axis 3 is deliberately not measured in v1.
    expect(res.body.data[0]).not.toHaveProperty('reachable');
    expect(res.body.data[0]).not.toHaveProperty('reachability');
  });

  it('the two axes are independent: adapter present but credential missing', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findMany.mockResolvedValue([providerRow()]);
    aiMock.getAiStatus.mockResolvedValue({
      status: 'operational',
      provider_adapters: [{ slug: 'openrouter', configured: false }],
    });

    const res = await request(app)
      .get('/api/v1/platform/providers')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.body.data[0].adapterAvailable).toBe(true);
    expect(res.body.data[0].credentialConfigured).toBe(false);
  });

  it('a slug with no registered adapter is adapterAvailable:false, credential null', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findMany.mockResolvedValue([providerRow({ slug: 'anthropic' })]);
    aiMock.getAiStatus.mockResolvedValue({
      status: 'operational',
      provider_adapters: [{ slug: 'openrouter', configured: true }],
    });

    const res = await request(app)
      .get('/api/v1/platform/providers')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.body.data[0].adapterAvailable).toBe(false);
    // No adapter means no credential to check — unanswerable, not "no".
    expect(res.body.data[0].credentialConfigured).toBeNull();
  });

  it('degrades gracefully: AI service down → both fields null, the list still renders', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findMany.mockResolvedValue([providerRow()]);
    aiMock.getAiStatus.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await request(app)
      .get('/api/v1/platform/providers')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].adapterAvailable).toBeNull();
    expect(res.body.data[0].credentialConfigured).toBeNull();
  });

  it('makes NO outbound provider request — readiness comes only from the AI service', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findMany.mockResolvedValue([providerRow()]);
    aiMock.getAiStatus.mockResolvedValue({
      status: 'operational',
      provider_adapters: [{ slug: 'openrouter', configured: true }],
    });

    await request(app).get('/api/v1/platform/providers').set('Authorization', authHeader(PLATFORM_USER));

    // `getAiStatus` is the single outbound seam, and the server imports no provider SDK —
    // the only network calls this route can make go to the AI service.
    expect(aiMock.getAiStatus).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH /api/v1/platform/providers/:providerId', () => {
  it('enables a provider (200) with a single-row update', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findUnique.mockResolvedValue({ id: PROVIDER_ID });
    prismaMock.aIProvider.update.mockResolvedValue(providerRow({ enabled: true }));

    const res = await request(app)
      .patch(`/api/v1/platform/providers/${PROVIDER_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(prismaMock.aIProvider.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PROVIDER_ID }, data: expect.objectContaining({ enabled: true }) })
    );
    // Disabling/enabling must not touch the provider's models (Concurrency R4).
    expect(prismaMock.aIModel.update).not.toHaveBeenCalled();
    expect(prismaMock.aIModel.delete).not.toHaveBeenCalled();
  });

  it('rejects `slug` with 400 and changes nothing', async () => {
    setPlatformRole('PLATFORM_OWNER');

    const res = await request(app)
      .patch(`/api/v1/platform/providers/${PROVIDER_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ slug: 'not-openrouter' });

    expect(res.status).toBe(400);
    expectNoWrites();
  });

  it('returns 404 for an unknown provider', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/v1/platform/providers/${PROVIDER_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ enabled: true });

    expect(res.status).toBe(404);
    expectNoWrites();
  });

  it('rejects a non-uuid provider id with 400', async () => {
    setPlatformRole('PLATFORM_OWNER');

    const res = await request(app)
      .patch('/api/v1/platform/providers/not-a-uuid')
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ enabled: true });

    expect(res.status).toBe(400);
    expectNoWrites();
  });
});

// ---------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------

describe('GET /api/v1/platform/models', () => {
  it('lists models with a live botCount (200)', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIModel.findMany.mockResolvedValue([modelRow({ _count: { bots: 2 } })]);

    const res = await request(app)
      .get('/api/v1/platform/models')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(200);
    expect(res.body.data[0].botCount).toBe(2);
    expect(res.body.data[0].provider.slug).toBe('openrouter');
  });

  it('passes the enabled filter through as a boolean', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIModel.findMany.mockResolvedValue([]);

    await request(app)
      .get('/api/v1/platform/models?enabled=true')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(prismaMock.aIModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ enabled: true }) })
    );
  });

  it('rejects a malformed enabled filter with 400', async () => {
    setPlatformRole('PLATFORM_OWNER');

    const res = await request(app)
      .get('/api/v1/platform/models?enabled=yes')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/platform/models', () => {
  it('creates a model (201) defaulting to disabled', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findUnique.mockResolvedValue({ id: PROVIDER_ID });
    prismaMock.aIModel.findUnique.mockResolvedValue(null);
    prismaMock.aIModel.create.mockResolvedValue(modelRow());

    const res = await request(app)
      .post('/api/v1/platform/models')
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ providerId: PROVIDER_ID, providerModelId: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini' });

    expect(res.status).toBe(201);
    // A newly catalogued model is not selectable until deliberately enabled.
    expect(prismaMock.aIModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ enabled: false }) })
    );
  });

  it('returns 409 for a duplicate (providerId, providerModelId)', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findUnique.mockResolvedValue({ id: PROVIDER_ID });
    prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID });

    const res = await request(app)
      .post('/api/v1/platform/models')
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ providerId: PROVIDER_ID, providerModelId: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini' });

    expect(res.status).toBe(409);
    expect(prismaMock.aIModel.create).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown providerId', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/v1/platform/models')
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ providerId: PROVIDER_ID, providerModelId: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini' });

    expect(res.status).toBe(404);
    expect(prismaMock.aIModel.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-uuid providerId', { providerId: 'nope', providerModelId: 'a/b', displayName: 'X' }],
    ['an empty providerModelId', { providerId: PROVIDER_ID, providerModelId: '', displayName: 'X' }],
    ['a whitespace-bearing providerModelId', { providerId: PROVIDER_ID, providerModelId: 'openai/ gpt', displayName: 'X' }],
    ['an over-long displayName', { providerId: PROVIDER_ID, providerModelId: 'a/b', displayName: 'x'.repeat(121) }],
  ])('rejects %s with 400', async (_label, body) => {
    setPlatformRole('PLATFORM_OWNER');

    const res = await request(app)
      .post('/api/v1/platform/models')
      .set('Authorization', authHeader(PLATFORM_USER))
      .send(body);

    expect(res.status).toBe(400);
    expect(prismaMock.aIModel.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/v1/platform/models/:modelId', () => {
  it('enables a model (200)', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID });
    prismaMock.aIModel.update.mockResolvedValue(modelRow({ enabled: true }));

    const res = await request(app)
      .patch(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
  });

  it('rejects providerModelId with 400 — immutable, not silently ignored', async () => {
    setPlatformRole('PLATFORM_OWNER');

    const res = await request(app)
      .patch(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ providerModelId: 'openai/gpt-4o' });

    // A 200 here would tell the client it renamed a model. It must be a hard rejection.
    expect(res.status).toBe(400);
    expectNoWrites();
  });

  it('rejects a body that carries BOTH an allowed field and providerModelId', async () => {
    setPlatformRole('PLATFORM_OWNER');

    const res = await request(app)
      .patch(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ displayName: 'New name', providerModelId: 'openai/gpt-4o' });

    expect(res.status).toBe(400);
    expectNoWrites();
  });

  it('rejects an empty body with 400 (at least one field required)', async () => {
    setPlatformRole('PLATFORM_OWNER');

    const res = await request(app)
      .patch(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({});

    expect(res.status).toBe(400);
    expectNoWrites();
  });

  it('returns 404 for an unknown model', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ enabled: true });

    expect(res.status).toBe(404);
    expectNoWrites();
  });
});

describe('DELETE /api/v1/platform/models/:modelId', () => {
  it('deletes an unreferenced model (200, data null)', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID, _count: { bots: 0 } });
    prismaMock.aIModel.delete.mockResolvedValue(modelRow());

    const res = await request(app)
      .delete(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(prismaMock.aIModel.delete).toHaveBeenCalledWith({ where: { id: MODEL_ID } });
  });

  it('returns 409 when a bot references the model, and does not delete', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID, _count: { bots: 2 } });

    const res = await request(app)
      .delete(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('2 bot');
    expect(prismaMock.aIModel.delete).not.toHaveBeenCalled();
  });

  it('maps a raced FK violation (P2003) to 409, never a 500', async () => {
    setPlatformRole('PLATFORM_OWNER');
    // The check saw zero bots; a bot was assigned in between, so the Restrict FK fires.
    prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID, _count: { bots: 0 } });
    prismaMock.aIModel.delete.mockRejectedValue(
      Object.assign(new Error('FK violation'), { code: 'P2003' })
    );

    const res = await request(app)
      .delete(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown model', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(404);
    expect(prismaMock.aIModel.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// Security: no credential or provider-native id leaks out of these endpoints
// ---------------------------------------------------------------------------------------

describe('AI catalog — response projections', () => {
  it('provider and model responses never carry a credential-derived field', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findMany.mockResolvedValue([providerRow()]);
    prismaMock.aIModel.findMany.mockResolvedValue([modelRow()]);
    aiMock.getAiStatus.mockResolvedValue({
      status: 'operational',
      provider_adapters: [{ slug: 'openrouter', configured: true }],
    });

    const providers = await request(app)
      .get('/api/v1/platform/providers')
      .set('Authorization', authHeader(PLATFORM_USER));
    const models = await request(app)
      .get('/api/v1/platform/models')
      .set('Authorization', authHeader(PLATFORM_USER));

    for (const row of [...providers.body.data, ...models.body.data]) {
      const keys = Object.keys(row).map((key) => key.toLowerCase());
      expect(keys).not.toContain('apikey');
      expect(keys).not.toContain('api_key');
      expect(keys.some((key) => key.includes('secret') || (key.includes('credential') && key !== 'credentialconfigured'))).toBe(false);
      // The only credential-derived value that may leave the server is the boolean.
      expect(JSON.stringify(row)).not.toMatch(/sk-or-/);
    }
  });

  /**
   * The scan above checks the fields this code *knows* about. This one is the general form:
   * it walks the whole payload, at every depth, and fails on any key that even looks like a
   * credential holder — so a future field named `apiKeyHint` or `providerSecret` fails here
   * rather than being missed by a hand-written list.
   *
   * `credentialConfigured` is the single permitted exception, and it is permitted only
   * because it is a boolean: the test asserts the type, so a later change that turned it
   * into a masked string ("sk-or-…abcd") fails rather than quietly shipping a credential
   * fragment to the browser.
   */
  const walk = (value: unknown, visit: (key: string, value: unknown) => void, key = '$'): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, visit, `${key}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childKey, childValue);
        walk(childValue, visit, `${key}.${childKey}`);
      }
    }
  };

  const CREDENTIAL_KEY = /(api[_-]?key|secret|token|password|credential)/i;

  it('no key anywhere in the platform or workspace catalog payload is credential-shaped', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findMany.mockResolvedValue([providerRow()]);
    prismaMock.aIModel.findMany.mockResolvedValue([modelRow()]);
    aiMock.getAiStatus.mockResolvedValue({
      status: 'operational',
      provider_adapters: [{ slug: 'openrouter', configured: true }],
    });

    const platformPayloads = [
      (await request(app).get('/api/v1/platform/providers').set('Authorization', authHeader(PLATFORM_USER))).body,
      (await request(app).get('/api/v1/platform/models').set('Authorization', authHeader(PLATFORM_USER))).body,
    ];

    // The workspace-facing read is included: it is the payload a browser sees most often.
    prismaMock.aIModel.findMany.mockResolvedValue([
      { id: MODEL_ID, displayName: 'GPT-4o mini', provider: { slug: 'openrouter', name: 'OpenRouter' } },
    ]);
    const workspacePayload = (
      await request(app).get('/api/v1/ai/models').set('Authorization', authHeader(PLATFORM_USER))
    ).body;

    const offenders: string[] = [];
    for (const payload of [...platformPayloads, workspacePayload]) {
      walk(payload, (key) => {
        if (CREDENTIAL_KEY.test(key) && key !== 'credentialConfigured') offenders.push(key);
      });
    }
    expect(offenders).toEqual([]);

    // And the one exception really is a boolean, never a string carrying any part of the key.
    for (const payload of platformPayloads) {
      walk(payload, (key, value) => {
        if (key !== 'credentialConfigured') return;
        expect(value === null || typeof value === 'boolean').toBe(true);
      });
    }
  });

  it('extra fields in the AI service report are projected away, not forwarded', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findMany.mockResolvedValue([providerRow()]);
    // The AI service is a separate deployable that answers with whatever its own models
    // declare. Node must build the readiness object field by field rather than pass the
    // adapter through — this fixture is what a pass-through would leak.
    aiMock.getAiStatus.mockResolvedValue({
      status: 'operational',
      provider_adapters: [
        { slug: 'openrouter', configured: true, apiKey: 'sk-or-v1-not-a-real-key', baseUrl: 'https://openrouter.ai/api/v1' },
      ],
    });

    const res = await request(app)
      .get('/api/v1/platform/providers')
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(200);
    const provider = res.body.data[0];
    expect(provider.adapterAvailable).toBe(true);
    expect(provider.credentialConfigured).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/sk-or-/);
    expect(JSON.stringify(res.body)).not.toContain('openrouter.ai');
  });
});

// ---------------------------------------------------------------------------------------
// S10 — catalog changes are attributable through structured logs
// ---------------------------------------------------------------------------------------

/**
 * v1 deliberately has **no audit table** (D21): no schema, no column, no endpoint. The
 * interim control is a Pino record per successful catalog mutation carrying the actor, the
 * action and the target, because a change to what every tenant may select has to be
 * answerable to "who did this?".
 *
 * "Exactly one" is the load-bearing part. Zero records means the control does not exist;
 * two means the log cannot be counted on to describe a single change, which is what makes it
 * usable during an incident.
 */
describe('AI catalog — attribution records (S10)', () => {
  const catalogRecords = () =>
    infoSpy.mock.calls.filter((call) => call[1] === 'ai catalog change');

  const recordFor = (action: string) => {
    const matches = catalogRecords().filter(([fields]) => fields.action === action);
    expect(matches, `expected exactly one ${action} record`).toHaveLength(1);
    return matches[0]![0] as Record<string, unknown>;
  };

  it('enabling a model records the actor, the action and the target', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID });
    prismaMock.aIModel.update.mockResolvedValue(modelRow({ enabled: true }));

    const res = await request(app)
      .patch(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ enabled: true });

    expect(res.status).toBe(200);
    const record = recordFor('model.enabled');
    expect(record.actorId).toBe(PLATFORM_USER.id);
    expect(record.targetId).toBe(MODEL_ID);
    expect(record.enabled).toBe(true);
  });

  it('disabling a model records a distinct action', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID });
    prismaMock.aIModel.update.mockResolvedValue(modelRow({ enabled: false }));

    const res = await request(app)
      .patch(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ enabled: false });

    expect(res.status).toBe(200);
    const record = recordFor('model.disabled');
    expect(record.actorId).toBe(PLATFORM_USER.id);
    expect(record.targetId).toBe(MODEL_ID);
    expect(record.enabled).toBe(false);
  });

  it('deleting a model records the label, which is the only place it survives', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue(modelRow({ _count: { bots: 0 } }));
    prismaMock.aIModel.delete.mockResolvedValue(modelRow());

    const res = await request(app)
      .delete(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER));

    expect(res.status).toBe(200);
    const record = recordFor('model.deleted');
    expect(record.actorId).toBe(PLATFORM_USER.id);
    expect(record.targetId).toBe(MODEL_ID);
    expect(record.displayName).toBe('GPT-4o mini');
  });

  it('enabling and disabling a provider are recorded against the provider', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIProvider.findUnique.mockResolvedValue({ id: PROVIDER_ID });

    prismaMock.aIProvider.update.mockResolvedValue(providerRow({ enabled: true }));
    await request(app)
      .patch(`/api/v1/platform/providers/${PROVIDER_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ enabled: true });

    prismaMock.aIProvider.update.mockResolvedValue(providerRow({ enabled: false }));
    await request(app)
      .patch(`/api/v1/platform/providers/${PROVIDER_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ enabled: false });

    expect(recordFor('provider.enabled').targetId).toBe(PROVIDER_ID);
    expect(recordFor('provider.disabled').targetId).toBe(PROVIDER_ID);
    expect(recordFor('provider.disabled').actorId).toBe(PLATFORM_USER.id);
    // Two changes, two records — the count is the control, so it is asserted directly.
    expect(catalogRecords()).toHaveLength(2);
  });

  it('a denied request is never attributed as a change', async () => {
    setPlatformRole('USER');

    const res = await request(app)
      .patch(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(NORMAL_USER))
      .send({ enabled: true });

    expect(res.status).toBe(403);
    // Nothing happened, so nothing is logged. A record here would put a name against a
    // change that never occurred — worse than no trail at all.
    expect(catalogRecords()).toHaveLength(0);
  });

  it('a rejected body is never attributed as a change', async () => {
    setPlatformRole('PLATFORM_OWNER');

    const res = await request(app)
      .patch(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ providerModelId: 'openai/gpt-4o' });

    expect(res.status).toBe(400);
    expect(catalogRecords()).toHaveLength(0);
  });

  it('the record carries no credential and no provider-native id', async () => {
    setPlatformRole('PLATFORM_OWNER');
    prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID });
    prismaMock.aIModel.update.mockResolvedValue(modelRow({ enabled: true }));

    await request(app)
      .patch(`/api/v1/platform/models/${MODEL_ID}`)
      .set('Authorization', authHeader(PLATFORM_USER))
      .send({ enabled: true });

    const serialized = JSON.stringify(catalogRecords());
    expect(serialized).not.toMatch(/sk-or-/);
    // The provider-native id would be a second way to name the model, and it is exactly what
    // the catalog exists to keep out of reach. The uuid is the identifier.
    expect(serialized).not.toContain('openai/gpt-4o-mini');
  });
});
