import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';

/**
 * Checkpoint 6 — concurrency and state consistency.
 *
 * These pin the guarantees in the plan's "Concurrency and state consistency" section, and
 * — just as importantly — nothing stronger. The plan names one race (R1) that it
 * deliberately does **not** close, so there is no test here asserting that a disable blocks
 * an already-in-flight request. A test like that would encode a promise the system does not
 * make, and would fail the moment someone relied on it.
 *
 * Where a guarantee is enforced by the database (the `Restrict` foreign key), the mock
 * cannot demonstrate it, so the constraint itself is asserted against the schema instead of
 * being implied by a scenario that only the mock is holding up. That distinction is stated
 * at each such test rather than glossed over.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  bot: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  aIProvider: { findUnique: vi.fn(), update: vi.fn() },
  aIModel: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
  conversation: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  message: { create: vi.fn() },
  // Checkpoint 5: the message path resolves the bot configuration as well as its model.
  botConfiguration: { findUnique: vi.fn() },
  knowledgeSource: { findMany: vi.fn() },
}));

const aiMock = vi.hoisted(() => ({ chat: vi.fn(), getAiStatus: vi.fn() }));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');
const { AI_FAILURE_REASON } = await import('../src/constants/aiFailure.js');

const OWNER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'owner@example.com' };
const PLATFORM = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', email: 'platform@example.com' };

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const PROVIDER_ID = '44444444-4444-4444-4444-444444444444';
const MODEL_A = '55555555-5555-5555-5555-555555555555';
const MODEL_B = '66666666-6666-6666-6666-666666666666';
const BOT_A = '22222222-2222-2222-2222-222222222222';
const CONV_A = '33333333-3333-3333-3333-333333333333';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

// --- A mutable catalog, so "committed" writes are visible to the next read --------------

interface CatalogModel {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  enabled: boolean;
}

const catalog: {
  provider: { id: string; slug: string; name: string; description: string | null; enabled: boolean };
  models: CatalogModel[];
  bots: Array<{ id: string; aiModelId: string | null }>;
} = {
  provider: { id: PROVIDER_ID, slug: 'openrouter', name: 'OpenRouter', description: null, enabled: true },
  models: [],
  bots: [],
};

/**
 * Rebuild the catalog from scratch before each test.
 *
 * Rebuilt rather than reset field-by-field because `deleteModel` splices a model out of the
 * array: restoring the flags of a row that no longer exists is not a reset, and a later test
 * would fail in `beforeEach` rather than in its own assertions — the most confusing way for
 * a suite to break.
 */
const resetCatalog = () => {
  catalog.provider = {
    id: PROVIDER_ID,
    slug: 'openrouter',
    name: 'OpenRouter',
    description: null,
    enabled: true,
  };
  catalog.models = [
    { id: MODEL_A, providerId: PROVIDER_ID, providerModelId: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini', enabled: true },
    { id: MODEL_B, providerId: PROVIDER_ID, providerModelId: 'anthropic/claude-sonnet-4', displayName: 'Claude Sonnet 4', enabled: true },
  ];
  catalog.bots = [{ id: BOT_A, aiModelId: null }];
};

const findModel = (id: string) => catalog.models.find((model) => model.id === id);
const findBot = (id: string) => catalog.bots.find((bot) => bot.id === id);
const botCount = (modelId: string) => catalog.bots.filter((bot) => bot.aiModelId === modelId).length;

const modelView = (model: CatalogModel) => ({
  ...model,
  provider: { ...catalog.provider },
  // A live count, never a stored counter.
  _count: { bots: botCount(model.id) },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetCatalog();

  prismaMock.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === PLATFORM.id ? { platformRole: 'PLATFORM_OWNER' } : { platformRole: 'USER' }
  );
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'member-1',
    userId: OWNER.id,
    workspaceId: WORKSPACE_ID,
    role: 'OWNER',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  /**
   * `aIModel.findUnique` serves two callers with different projections: assignment asks for
   * the two enablement flags, deletion asks for a live bot count. Honouring `select` keeps
   * each caller exercised against the shape it actually requests — a superset would have let
   * the assignment path pass on a mock that returned `enabled` it never asked for.
   */
  prismaMock.aIModel.findUnique.mockImplementation(
    async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
      const model = findModel(where.id);
      if (!model) return null;

      if (select && 'provider' in select) {
        return {
          id: model.id,
          enabled: model.enabled,
          provider: { enabled: catalog.provider.enabled },
        };
      }

      return { id: model.id, _count: { bots: botCount(model.id) } };
    }
  );
  prismaMock.aIModel.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Partial<CatalogModel> }) => {
      const model = findModel(where.id);
      if (!model) throw new Error('model not found');
      if (data.enabled !== undefined) model.enabled = data.enabled;
      return modelView(model);
    }
  );
  prismaMock.aIModel.delete.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const index = catalog.models.findIndex((model) => model.id === where.id);
    if (index === -1) throw new Error('model not found');
    return catalog.models.splice(index, 1)[0];
  });
  prismaMock.aIProvider.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === catalog.provider.id ? { id: catalog.provider.id } : null
  );
  prismaMock.aIProvider.update.mockImplementation(async ({ data }: { data: { enabled?: boolean } }) => {
    if (data.enabled !== undefined) catalog.provider.enabled = data.enabled;
    return {
      ...catalog.provider,
      models: catalog.models.map((model) => ({ enabled: model.enabled })),
    };
  });

  // Three reads of the same row, distinguished by `select`: the permission middleware's
  // scope read, the configuration read (Checkpoint 5), and the model resolver's read.
  prismaMock.bot.findUnique.mockImplementation(
    async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
      const bot = findBot(where.id);
      if (!bot) return null;
      // The configuration projection asks for `isActive`; it must be distinguished from the
      // resolver's read, which also asks for `aiModelId`.
      if (select && 'isActive' in select) {
        return { isActive: true, aiModelId: bot.aiModelId, fallbackAiModelId: null };
      }
      if (select && 'aiModelId' in select) {
        const model = bot.aiModelId ? findModel(bot.aiModelId) : null;
        return {
          aiModelId: bot.aiModelId,
          fallbackAiModelId: null,
          aiModel: model
            ? {
                providerModelId: model.providerModelId,
                enabled: model.enabled,
                provider: { slug: catalog.provider.slug, enabled: catalog.provider.enabled },
              }
            : null,
          fallbackAiModel: null,
        };
      }
      return { workspaceId: WORKSPACE_ID };
    }
  );
  prismaMock.botConfiguration.findUnique.mockResolvedValue(null);
  prismaMock.bot.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const bot = findBot(where.id);
    return bot ? { id: bot.id, name: 'Helper', description: null, workspaceId: WORKSPACE_ID, aiModelId: bot.aiModelId } : null;
  });
  prismaMock.bot.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: { aiModelId: string | null } }) => {
      const bot = findBot(where.id);
      if (!bot) throw new Error('bot not found');
      bot.aiModelId = data.aiModelId;
      return { ...bot, aiModel: bot.aiModelId ? modelView(findModel(bot.aiModelId)!) : null };
    }
  );

  prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });
  prismaMock.conversation.findFirst.mockResolvedValue({ id: CONV_A, botId: BOT_A });
  prismaMock.conversation.update.mockResolvedValue({ id: CONV_A, status: 'WAITING_FOR_HUMAN' });
  prismaMock.message.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'msg',
    conversationId: args.data.conversationId,
    role: args.data.role,
    content: args.data.content,
    createdAt: new Date(),
  }));

  aiMock.chat.mockResolvedValue({ status: 'success', response: 'ok', fallback_required: false });
  aiMock.getAiStatus.mockResolvedValue({ provider_adapters: [{ slug: 'openrouter', configured: true }] });
});

// --- Request helpers ---------------------------------------------------------------------

const assignModel = (modelId: string | null) =>
  request(app)
    .patch(`/api/v1/bots/${BOT_A}/model`)
    .set('Authorization', authHeader(OWNER))
    .send({ aiModelId: modelId });

const deleteModel = (modelId: string) =>
  request(app).delete(`/api/v1/platform/models/${modelId}`).set('Authorization', authHeader(PLATFORM));

const setModelEnabled = (modelId: string, enabled: boolean) =>
  request(app)
    .patch(`/api/v1/platform/models/${modelId}`)
    .set('Authorization', authHeader(PLATFORM))
    .send({ enabled });

const setProviderEnabled = (enabled: boolean) =>
  request(app)
    .patch(`/api/v1/platform/providers/${PROVIDER_ID}`)
    .set('Authorization', authHeader(PLATFORM))
    .send({ enabled });

const chat = () =>
  request(app)
    .post(`/api/v1/conversations/${CONV_A}/messages`)
    .set('Authorization', authHeader(OWNER))
    .send({ content: 'Hello?' });

// ---------------------------------------------------------------------------------------
// R1 — a disable during flight
// ---------------------------------------------------------------------------------------

describe('R1 — a disable during flight', () => {
  it('does not retroactively reject a request that already resolved', async () => {
    await assignModel(MODEL_A);

    /**
     * Hold the AI call open so the disable genuinely lands *mid-flight*.
     *
     * The ordering has to be forced rather than assumed: supertest dispatches lazily, so
     * firing the request and immediately awaiting the disable would let the write commit
     * first and turn this into an ordinary "already disabled" case — which is a different
     * assertion wearing the same name. Awaiting `started` waits for the resolver to have
     * read the pre-disable state before the write happens.
     */
    let markStarted: () => void = () => {};
    let release: (value: unknown) => void = () => {};
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    aiMock.chat.mockImplementation(() => {
      markStarted();
      return new Promise((resolve) => { release = resolve; });
    });

    // `.then(identity)` dispatches the request now, rather than at the `await` below.
    const inFlight = chat().then((response) => response);
    await started;
    await setModelEnabled(MODEL_A, false);
    release({ status: 'success', response: 'answered anyway', fallback_required: false });

    const completed = await inFlight;

    // R1 explicitly does not promise to block this, and the plan forbids asserting that it
    // does. At most one request per bot can be served by a just-disabled model; the cost is
    // one answer from a model that was legal microseconds earlier.
    expect(completed.status).toBe(201);
    expect(completed.body.data.ai.fallback_required).toBe(false);
    expect(completed.body.data.assistantMessage.content).toBe('answered anyway');
  });

  it('the next request observes the new state', async () => {
    await assignModel(MODEL_A);
    await chat();
    await setModelEnabled(MODEL_A, false);

    const next = await chat();

    // The guarantee that *is* made: a disable takes effect for every request that begins
    // after the write commits.
    expect(next.body.data.ai.reason).toBe(AI_FAILURE_REASON.MODEL_UNAVAILABLE);
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------
// R2 — concurrent assignment writes to the same bot
// ---------------------------------------------------------------------------------------

describe('R2 — concurrent assignment (last-write-wins)', () => {
  it('both writes succeed and the stored value is exactly one of them', async () => {
    const [first, second] = await Promise.all([assignModel(MODEL_A), assignModel(MODEL_B)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Well-formed, never a mix and never null: each request is a single `UPDATE` of one
    // column, and the database chooses the winner.
    expect([MODEL_A, MODEL_B]).toContain(findBot(BOT_A)!.aiModelId);
  });

  it('never stores a value that was not validated', async () => {
    // One of the two is not a catalog model at all.
    const unknown = '99999999-9999-9999-9999-999999999999';
    const [valid, invalid] = await Promise.all([assignModel(MODEL_A), assignModel(unknown)]);

    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(400);
    // The rejected write left nothing behind.
    expect(findBot(BOT_A)!.aiModelId).toBe(MODEL_A);
  });

  it('has no optimistic-concurrency machinery — the plan puts it out of scope for v1', async () => {
    await assignModel(MODEL_A);
    const again = await assignModel(MODEL_B);

    // A second write by a second tab overwrites the first rather than returning 409. This
    // is the documented v1 behaviour, pinned so that adding version columns later is a
    // deliberate change rather than an accident.
    expect(again.status).toBe(200);
    expect(findBot(BOT_A)!.aiModelId).toBe(MODEL_B);
  });
});

// ---------------------------------------------------------------------------------------
// R3 — a model deleted while a bot is being assigned to it, or is already assigned
// ---------------------------------------------------------------------------------------

describe('R3 — delete racing assignment', () => {
  it('delete first: the assignment then fails validation with 400 and changes nothing', async () => {
    await deleteModel(MODEL_A);
    expect(findModel(MODEL_A)).toBeUndefined();

    const res = await assignModel(MODEL_A);

    expect(res.status).toBe(400);
    expect(findBot(BOT_A)!.aiModelId).toBeNull();
  });

  it('assign first: the delete is refused with 409 and the model row survives', async () => {
    await assignModel(MODEL_A);

    const res = await deleteModel(MODEL_A);

    expect(res.status).toBe(409);
    expect(findModel(MODEL_A)).toBeDefined();
    expect(findBot(BOT_A)!.aiModelId).toBe(MODEL_A);
  });

  it('the delete guard reads a live bot count, so a just-committed assignment is seen', async () => {
    // The count is derived per request, so there is no denormalised counter to drift. An
    // assignment committed moments earlier is reflected in the very next delete.
    expect(botCount(MODEL_A)).toBe(0);
    await assignModel(MODEL_A);

    await deleteModel(MODEL_A);

    expect(botCount(MODEL_A)).toBe(1);
    expect(findModel(MODEL_A)).toBeDefined();
  });

  it('no interleaving leaves a bot pointing at a deleted model', async () => {
    await assignModel(MODEL_A);
    await deleteModel(MODEL_A);
    await deleteModel(MODEL_B);

    // In this scenario the mock is what holds the invariant, so this assertion alone proves
    // only that the two paths agree. The guarantee itself is the foreign key, asserted
    // structurally in the next test — that is what makes the state unrepresentable rather
    // than merely unreached.
    const referenced = catalog.bots.filter(
      (bot) => bot.aiModelId !== null && !findModel(bot.aiModelId)
    );
    expect(referenced).toEqual([]);
  });

  it('the schema makes an orphaned assignment unrepresentable', () => {
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const botModel = /model Bot \{([\s\S]*?)\n\}/.exec(schema)?.[1];

    expect(botModel).toBeDefined();
    // `Restrict` on the bot's model reference: a referenced model cannot be deleted by any
    // path, including a raw SQL DELETE that bypasses the service's courteous 409. `SetNull`
    // would silently change a bot's behaviour; `Cascade` would delete bots.
    expect(botModel).toMatch(/aiModel\s+AIModel\?\s+@relation\([^)]*onDelete:\s*Restrict/);
  });
});

// ---------------------------------------------------------------------------------------
// R4 — provider disable versus model enable
// ---------------------------------------------------------------------------------------

describe('R4 — a provider disable is not a data mutation', () => {
  it('changes zero AIModel rows and preserves every per-model flag', async () => {
    // A deliberately mixed baseline: one enabled, one disabled.
    await setModelEnabled(MODEL_B, false);
    const before = catalog.models.map((model) => model.enabled);

    await setProviderEnabled(false);

    // Not a cascade over child rows — a single flag on the provider. This is exactly why
    // re-enabling restores the previous selection rather than a uniform "all enabled".
    expect(catalog.models.map((model) => model.enabled)).toEqual(before);
    expect(prismaMock.aIModel.update).toHaveBeenCalledTimes(1); // the baseline edit only
  });

  it('re-enabling the provider restores exactly the previous per-model selection', async () => {
    // A deliberately mixed baseline: one model enabled, one disabled.
    await setModelEnabled(MODEL_B, false);
    const selection = catalog.models.map((model) => ({ id: model.id, enabled: model.enabled }));

    await setProviderEnabled(false);
    await setProviderEnabled(true);

    // Restored exactly, not uniformised. A cascade-based disable would have written
    // `enabled: false` to every child and re-enabling could only ever produce "all on".
    expect(catalog.models.map((model) => ({ id: model.id, enabled: model.enabled }))).toEqual(selection);
    expect(findModel(MODEL_A)!.enabled).toBe(true);
    expect(findModel(MODEL_B)!.enabled).toBe(false);
  });

  it('an existing assignment survives a provider disable and re-enable unchanged', async () => {
    await assignModel(MODEL_A);

    await setProviderEnabled(false);
    await setProviderEnabled(true);

    expect(findBot(BOT_A)!.aiModelId).toBe(MODEL_A);
  });

  it('a provider-wide disable hides every model under it without touching a row', async () => {
    await assignModel(MODEL_A);
    await setProviderEnabled(false);

    const blocked = await chat();

    expect(blocked.body.data.ai.reason).toBe(AI_FAILURE_REASON.MODEL_UNAVAILABLE);
    expect(aiMock.chat).not.toHaveBeenCalled();
  });
});
