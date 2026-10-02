import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/**
 * Checkpoint 8 — Security and regression testing. Extended in Checkpoint 9 to cover the AI
 * catalog routes, so the new surface is swept by the same table rather than by a suite of
 * its own that could quietly drift from it.
 *
 * A table-driven sweep of the **real route table** (not a synthetic app), asserting the
 * authorization outcome of every workspace-scoped route for every role, plus the platform
 * boundary and the unauthenticated case.
 *
 * Three invariants are what make this a security suite rather than a status-code snapshot:
 *
 *   1. **Identity is the only variable.** Every case differs from the others solely in the
 *      caller's role (or in there being no member row at all). If a route's gate is wrong,
 *      some row of the table fails — there is no per-route test to quietly "fix".
 *   2. **A denied request writes nothing.** Every 4xx case asserts that *no* write mock was
 *      called, so a gate placed after a mutation would be caught even if the status code
 *      happened to be right.
 *   3. **Cross-tenant is 404, never 403.** A non-member must be unable to distinguish a
 *      tenant they cannot see from one that does not exist.
 *
 * The complementary half — that the service layer *itself* scopes by membership, so the
 * isolation survives even if the middleware is removed — is pinned in rbac-compat.test.ts.
 */

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
    deleteMany: vi.fn(),
  },
  conversation: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  message: { create: vi.fn() },
  aIProvider: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  aIModel: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// The AI boundary is mocked: this suite is about authorization, and no Python service
// should be required to prove it.
const aiMock = vi.hoisted(() => ({
  chat: vi.fn(),
  classifyIntent: vi.fn(),
  ingestKnowledge: vi.fn(),
  deleteBotKnowledge: vi.fn(),
  getAiStatus: vi.fn(),
  getSystemStatus: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'caller@example.com' };
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333';
const KNOWLEDGE_ID = '44444444-4444-4444-4444-444444444444';
const MEMBER_ID = '55555555-5555-5555-5555-555555555555';
const MODEL_ID = '66666666-6666-6666-6666-666666666666';
const PROVIDER_ID = '77777777-7777-7777-7777-777777777777';

const authHeader = (): string => `Bearer ${signToken({ sub: USER.id, email: USER.email })}`;

const memberRow = (role: 'OWNER' | 'ADMIN' | 'AGENT') => ({
  id: 'member-1',
  userId: USER.id,
  workspaceId: WORKSPACE_ID,
  role,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const WORKSPACE_ROW = {
  id: WORKSPACE_ID,
  name: 'Support',
  ownerId: USER.id,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const BOT_ROW = {
  id: BOT_ID,
  name: 'Helper',
  description: null,
  workspaceId: WORKSPACE_ID,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * The shape `aiCatalogService` selects for a provider — every field `toProviderView`
 * destructures, including the `models` relation its counts are derived from. A partial row
 * here would throw inside the view mapper and surface as a 500, which the sweep would
 * report as a missing platform-owner case rather than as the fixture bug it is.
 */
const PROVIDER_ROW = {
  id: PROVIDER_ID,
  slug: 'openrouter',
  name: 'OpenRouter',
  description: null,
  enabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  models: [],
};

/** Likewise for a model: `toModelView` needs `_count` and the provider summary. */
const MODEL_ROW = {
  id: MODEL_ID,
  providerId: PROVIDER_ID,
  providerModelId: 'openai/gpt-4o-mini',
  displayName: 'GPT-4o mini',
  enabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  provider: { id: PROVIDER_ID, slug: 'openrouter', name: 'OpenRouter', enabled: true },
  _count: { bots: 0 },
};

/**
 * The caller's relationship to the workspace. `PLATFORM_OWNER` is deliberately a
 * *non-member*: the platform role must grant nothing inside the workspace domain.
 */
type Identity = 'OWNER' | 'ADMIN' | 'AGENT' | 'NON_MEMBER' | 'PLATFORM_OWNER';

interface Case {
  /** `it.each` interpolates `$label` into the test name, so it must describe the claim. */
  label: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  as: Identity;
  expect: number;
  body?: Record<string, unknown>;
  /** Runs after the shared setup, to prime the service reads a 2xx case needs. */
  prime?: () => void;
}

/** Every mock that mutates state. A denied request must touch none of them. */
const writeMocks = (): ReturnType<typeof vi.fn>[] => [
  prismaMock.workspace.create,
  prismaMock.workspaceMember.create,
  prismaMock.workspaceMember.update,
  prismaMock.workspaceMember.delete,
  prismaMock.bot.create,
  prismaMock.bot.update,
  prismaMock.bot.delete,
  prismaMock.knowledgeEntry.create,
  prismaMock.knowledgeEntry.update,
  prismaMock.knowledgeEntry.delete,
  prismaMock.knowledgeEntry.deleteMany,
  prismaMock.conversation.create,
  prismaMock.conversation.update,
  prismaMock.message.create,
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

/** Arrange the world for one case and perform the request. */
const runCase = async (c: Case) => {
  // Scope resolution happens before the permission check: every workspace-scoped route
  // first resolves its workspace through params, bot, knowledge entry or conversation.
  // These defaults resolve to the workspace the identities below belong to; the
  // "resource is missing" and "resource is absent" cases override them in `prime`.
  prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
  prismaMock.knowledgeEntry.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });
  prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });

  if (c.as === 'NON_MEMBER' || c.as === 'PLATFORM_OWNER') {
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);
  } else {
    prismaMock.workspaceMember.findUnique.mockResolvedValue(memberRow(c.as));
  }
  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: c.as === 'PLATFORM_OWNER' ? 'PLATFORM_OWNER' : 'USER',
  });

  c.prime?.();

  const test =
    c.method === 'get'
      ? request(app).get(c.path)
      : c.method === 'post'
        ? request(app).post(c.path)
        : c.method === 'patch'
          ? request(app).patch(c.path)
          : request(app).delete(c.path);

  test.set('Authorization', authHeader());
  return c.body ? test.send(c.body) : test;
};

const expectCase = async (c: Case): Promise<void> => {
  const res = await runCase(c);
  expect(res.status, `${c.label} → ${JSON.stringify(res.body)}`).toBe(c.expect);
  // Invariant 2: a denied request must not have reached a mutation.
  if (c.expect >= 400) {
    expectNoWrites();
  }
};

beforeEach(() => {
  // reset (not clear): a leftover implementation from a previous case could otherwise let
  // a later request travel further than its own arrangement allows.
  vi.resetAllMocks();
});

describe('workspace routes', () => {
  const cases: Case[] = [
    { label: 'OWNER reads the workspace (workspace:view)', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}`, as: 'OWNER', expect: 200, prime: () => prismaMock.workspace.findFirst.mockResolvedValue(WORKSPACE_ROW) },
    { label: 'ADMIN reads the workspace', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}`, as: 'ADMIN', expect: 200, prime: () => prismaMock.workspace.findFirst.mockResolvedValue(WORKSPACE_ROW) },
    { label: 'AGENT reads the workspace', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}`, as: 'AGENT', expect: 200, prime: () => prismaMock.workspace.findFirst.mockResolvedValue(WORKSPACE_ROW) },
    { label: 'a non-member gets 404, not 403', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}`, as: 'NON_MEMBER', expect: 404 },
    {
      label: 'a PLATFORM_OWNER with no membership still gets 404 — the platform role grants nothing in the workspace domain',
      method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}`, as: 'PLATFORM_OWNER', expect: 404,
    },

    // Workspace update/delete are not implemented: `workspace:update` and `workspace:delete`
    // are granted to OWNER in the matrix but no route consumes them, so these fall through
    // to the 404 handler for every role. Pinned so the gap stays visible, and so the day a
    // delete route is added without a gate, these two rows fail.
    { label: 'workspace delete is unimplemented → 404 even for OWNER (no route exists)', method: 'delete', path: `/api/v1/workspaces/${WORKSPACE_ID}`, as: 'OWNER', expect: 404 },
    { label: 'workspace update is unimplemented → 404 even for OWNER (no route exists)', method: 'patch', path: `/api/v1/workspaces/${WORKSPACE_ID}`, as: 'OWNER', expect: 404, body: { name: 'Renamed' } },
  ];

  it.each(cases)('$label', expectCase);
});

describe('workspace member routes', () => {
  const cases: Case[] = [
    { label: 'OWNER lists members (members:view)', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}/members`, as: 'OWNER', expect: 200, prime: () => prismaMock.workspaceMember.findMany.mockResolvedValue([memberRow('OWNER')]) },
    { label: 'ADMIN lists members', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}/members`, as: 'ADMIN', expect: 200, prime: () => prismaMock.workspaceMember.findMany.mockResolvedValue([memberRow('ADMIN')]) },
    { label: 'AGENT cannot list members (no members:view) → 403', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}/members`, as: 'AGENT', expect: 403 },
    { label: 'a non-member listing members gets 404', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}/members`, as: 'NON_MEMBER', expect: 404 },

    { label: 'ADMIN cannot add a member (members:manage is OWNER only) → 403', method: 'post', path: `/api/v1/workspaces/${WORKSPACE_ID}/members`, as: 'ADMIN', expect: 403, body: { email: 'new@example.com', role: 'AGENT' } },
    { label: 'AGENT cannot add a member → 403', method: 'post', path: `/api/v1/workspaces/${WORKSPACE_ID}/members`, as: 'AGENT', expect: 403, body: { email: 'new@example.com', role: 'AGENT' } },
    { label: 'a non-member adding a member gets 404', method: 'post', path: `/api/v1/workspaces/${WORKSPACE_ID}/members`, as: 'NON_MEMBER', expect: 404, body: { email: 'new@example.com', role: 'AGENT' } },

    { label: 'ADMIN cannot change a member role → 403', method: 'patch', path: `/api/v1/workspaces/${WORKSPACE_ID}/members/${MEMBER_ID}`, as: 'ADMIN', expect: 403, body: { role: 'ADMIN' } },
    { label: 'AGENT cannot change a member role → 403', method: 'patch', path: `/api/v1/workspaces/${WORKSPACE_ID}/members/${MEMBER_ID}`, as: 'AGENT', expect: 403, body: { role: 'ADMIN' } },
    { label: 'a non-member changing a role gets 404', method: 'patch', path: `/api/v1/workspaces/${WORKSPACE_ID}/members/${MEMBER_ID}`, as: 'NON_MEMBER', expect: 404, body: { role: 'ADMIN' } },

    { label: 'ADMIN cannot remove a member → 403', method: 'delete', path: `/api/v1/workspaces/${WORKSPACE_ID}/members/${MEMBER_ID}`, as: 'ADMIN', expect: 403 },
    { label: 'AGENT cannot remove a member → 403', method: 'delete', path: `/api/v1/workspaces/${WORKSPACE_ID}/members/${MEMBER_ID}`, as: 'AGENT', expect: 403 },
    { label: 'a non-member removing a member gets 404', method: 'delete', path: `/api/v1/workspaces/${WORKSPACE_ID}/members/${MEMBER_ID}`, as: 'NON_MEMBER', expect: 404 },
  ];

  it.each(cases)('$label', expectCase);
});

describe('bot routes — nested under a workspace (params scope)', () => {
  const cases: Case[] = [
    { label: 'OWNER creates a bot (bots:manage)', method: 'post', path: `/api/v1/workspaces/${WORKSPACE_ID}/bots`, as: 'OWNER', expect: 201, body: { name: 'Helper' }, prime: () => { prismaMock.workspace.findFirst.mockResolvedValue(WORKSPACE_ROW); prismaMock.bot.create.mockResolvedValue(BOT_ROW); } },
    { label: 'ADMIN creates a bot', method: 'post', path: `/api/v1/workspaces/${WORKSPACE_ID}/bots`, as: 'ADMIN', expect: 201, body: { name: 'Helper' }, prime: () => { prismaMock.workspace.findFirst.mockResolvedValue(WORKSPACE_ROW); prismaMock.bot.create.mockResolvedValue(BOT_ROW); } },
    { label: 'AGENT cannot create a bot → 403', method: 'post', path: `/api/v1/workspaces/${WORKSPACE_ID}/bots`, as: 'AGENT', expect: 403, body: { name: 'Helper' } },
    { label: 'a non-member creating a bot gets 404', method: 'post', path: `/api/v1/workspaces/${WORKSPACE_ID}/bots`, as: 'NON_MEMBER', expect: 404, body: { name: 'Helper' } },

    { label: 'OWNER lists bots (bots:view)', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}/bots`, as: 'OWNER', expect: 200, prime: () => { prismaMock.workspace.findFirst.mockResolvedValue(WORKSPACE_ROW); prismaMock.bot.findMany.mockResolvedValue([BOT_ROW]); } },
    { label: 'ADMIN lists bots', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}/bots`, as: 'ADMIN', expect: 200, prime: () => { prismaMock.workspace.findFirst.mockResolvedValue(WORKSPACE_ROW); prismaMock.bot.findMany.mockResolvedValue([BOT_ROW]); } },
    { label: 'AGENT cannot list bots (AGENT has no bots:view) → 403', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}/bots`, as: 'AGENT', expect: 403 },
    { label: 'a non-member listing bots gets 404', method: 'get', path: `/api/v1/workspaces/${WORKSPACE_ID}/bots`, as: 'NON_MEMBER', expect: 404 },
  ];

  it.each(cases)('$label', expectCase);
});

describe('bot routes — top level (bot scope)', () => {
  const cases: Case[] = [
    { label: 'OWNER reads a bot', method: 'get', path: `/api/v1/bots/${BOT_ID}`, as: 'OWNER', expect: 200, prime: () => prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW) },
    { label: 'ADMIN reads a bot', method: 'get', path: `/api/v1/bots/${BOT_ID}`, as: 'ADMIN', expect: 200, prime: () => prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW) },
    { label: 'AGENT cannot read a bot → 403', method: 'get', path: `/api/v1/bots/${BOT_ID}`, as: 'AGENT', expect: 403 },
    { label: 'a non-member reading a bot gets 404', method: 'get', path: `/api/v1/bots/${BOT_ID}`, as: 'NON_MEMBER', expect: 404 },
    { label: 'a bot that does not exist is 404 even for a member', method: 'get', path: `/api/v1/bots/${BOT_ID}`, as: 'OWNER', expect: 404, prime: () => prismaMock.bot.findUnique.mockResolvedValue(null) },

    { label: 'ADMIN updates a bot (bots:manage)', method: 'patch', path: `/api/v1/bots/${BOT_ID}`, as: 'ADMIN', expect: 200, body: { name: 'Renamed' }, prime: () => { prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW); prismaMock.bot.update.mockResolvedValue(BOT_ROW); } },
    { label: 'AGENT cannot update a bot → 403', method: 'patch', path: `/api/v1/bots/${BOT_ID}`, as: 'AGENT', expect: 403, body: { name: 'Renamed' } },
    { label: 'a non-member updating a bot gets 404', method: 'patch', path: `/api/v1/bots/${BOT_ID}`, as: 'NON_MEMBER', expect: 404, body: { name: 'Renamed' } },

    { label: 'OWNER deletes a bot', method: 'delete', path: `/api/v1/bots/${BOT_ID}`, as: 'OWNER', expect: 200, prime: () => { prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW); prismaMock.bot.delete.mockResolvedValue(BOT_ROW); aiMock.deleteBotKnowledge.mockResolvedValue(undefined); } },
    { label: 'AGENT cannot delete a bot → 403', method: 'delete', path: `/api/v1/bots/${BOT_ID}`, as: 'AGENT', expect: 403 },
    { label: 'a non-member deleting a bot gets 404', method: 'delete', path: `/api/v1/bots/${BOT_ID}`, as: 'NON_MEMBER', expect: 404 },
  ];

  it.each(cases)('$label', expectCase);
});

describe('bot model assignment (Checkpoint 3)', () => {
  const cases: Case[] = [
    { label: 'OWNER assigns a model to a bot (bots:manage)', method: 'patch', path: `/api/v1/bots/${BOT_ID}/model`, as: 'OWNER', expect: 200, body: { aiModelId: MODEL_ID }, prime: () => { prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW); prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID, enabled: true, provider: { enabled: true } }); prismaMock.bot.update.mockResolvedValue(BOT_ROW); } },
    { label: 'ADMIN assigns a model to a bot', method: 'patch', path: `/api/v1/bots/${BOT_ID}/model`, as: 'ADMIN', expect: 200, body: { aiModelId: MODEL_ID }, prime: () => { prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW); prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID, enabled: true, provider: { enabled: true } }); prismaMock.bot.update.mockResolvedValue(BOT_ROW); } },
    { label: 'OWNER clears a model assignment with null', method: 'patch', path: `/api/v1/bots/${BOT_ID}/model`, as: 'OWNER', expect: 200, body: { aiModelId: null }, prime: () => { prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW); prismaMock.bot.update.mockResolvedValue(BOT_ROW); } },

    // AGENT holds neither bots:manage nor bots:view, so the model selector must be closed
    // to it entirely — and, per invariant 2, the denial must write nothing.
    { label: 'AGENT cannot assign a model → 403', method: 'patch', path: `/api/v1/bots/${BOT_ID}/model`, as: 'AGENT', expect: 403, body: { aiModelId: MODEL_ID } },
    { label: 'a non-member assigning a model gets 404', method: 'patch', path: `/api/v1/bots/${BOT_ID}/model`, as: 'NON_MEMBER', expect: 404, body: { aiModelId: MODEL_ID } },
    { label: 'a PLATFORM_OWNER with no membership gets 404 — the platform role grants nothing here', method: 'patch', path: `/api/v1/bots/${BOT_ID}/model`, as: 'PLATFORM_OWNER', expect: 404, body: { aiModelId: MODEL_ID } },
  ];

  it.each(cases)('$label', expectCase);
});

describe('workspace AI catalog route (Checkpoint 3)', () => {
  const cases: Case[] = [
    // Deliberately authenticated-but-unscoped: the list of enabled models is identical for
    // every caller and carries no tenant data.
    { label: 'AGENT can read the model catalog — it is not tenant data', method: 'get', path: '/api/v1/ai/models', as: 'AGENT', expect: 200, prime: () => prismaMock.aIModel.findMany.mockResolvedValue([]) },
    { label: 'OWNER reads the model catalog', method: 'get', path: '/api/v1/ai/models', as: 'OWNER', expect: 200, prime: () => prismaMock.aIModel.findMany.mockResolvedValue([]) },
    { label: 'a non-member still reads the catalog — it is global, not per-tenant', method: 'get', path: '/api/v1/ai/models', as: 'NON_MEMBER', expect: 200, prime: () => prismaMock.aIModel.findMany.mockResolvedValue([]) },
  ];

  it.each(cases)('$label', expectCase);
});

describe('knowledge routes', () => {
  const cases: Case[] = [
    { label: 'OWNER lists knowledge (knowledge:view)', method: 'get', path: `/api/v1/bots/${BOT_ID}/knowledge`, as: 'OWNER', expect: 200, prime: () => { prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW); prismaMock.knowledgeEntry.findMany.mockResolvedValue([]); } },
    { label: 'AGENT lists knowledge — read-only context is granted', method: 'get', path: `/api/v1/bots/${BOT_ID}/knowledge`, as: 'AGENT', expect: 200, prime: () => { prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW); prismaMock.knowledgeEntry.findMany.mockResolvedValue([]); } },
    { label: 'a non-member listing knowledge gets 404', method: 'get', path: `/api/v1/bots/${BOT_ID}/knowledge`, as: 'NON_MEMBER', expect: 404 },

    { label: 'ADMIN adds knowledge (knowledge:manage)', method: 'post', path: `/api/v1/bots/${BOT_ID}/knowledge`, as: 'ADMIN', expect: 201, body: { question: 'Hours?', answer: 'Nine to five.', category: 'General' }, prime: () => { prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW); prismaMock.knowledgeEntry.create.mockResolvedValue({ id: KNOWLEDGE_ID, botId: BOT_ID, title: null, category: 'General', question: 'Hours?', answer: 'Nine to five.', createdAt: new Date(), updatedAt: new Date() }); aiMock.ingestKnowledge.mockResolvedValue(undefined); } },
    { label: 'AGENT cannot add knowledge → 403', method: 'post', path: `/api/v1/bots/${BOT_ID}/knowledge`, as: 'AGENT', expect: 403, body: { question: 'Hours?', answer: 'Nine to five.', category: 'General' } },
    { label: 'a non-member adding knowledge gets 404', method: 'post', path: `/api/v1/bots/${BOT_ID}/knowledge`, as: 'NON_MEMBER', expect: 404, body: { question: 'Hours?', answer: 'Nine to five.', category: 'General' } },

    { label: 'AGENT cannot delete all knowledge → 403', method: 'delete', path: `/api/v1/bots/${BOT_ID}/knowledge`, as: 'AGENT', expect: 403 },
    { label: 'a non-member deleting all knowledge gets 404', method: 'delete', path: `/api/v1/bots/${BOT_ID}/knowledge`, as: 'NON_MEMBER', expect: 404 },

    { label: 'AGENT cannot upload a document (documents:manage) → 403', method: 'post', path: `/api/v1/bots/${BOT_ID}/knowledge/upload-document`, as: 'AGENT', expect: 403 },
    { label: 'a non-member uploading a document gets 404', method: 'post', path: `/api/v1/bots/${BOT_ID}/knowledge/upload-document`, as: 'NON_MEMBER', expect: 404 },

    { label: 'ADMIN updates a knowledge entry', method: 'patch', path: `/api/v1/knowledge/${KNOWLEDGE_ID}`, as: 'ADMIN', expect: 200, body: { answer: 'Nine to six.' }, prime: () => { prismaMock.knowledgeEntry.findFirst.mockResolvedValue({ id: KNOWLEDGE_ID }); prismaMock.knowledgeEntry.update.mockResolvedValue({ id: KNOWLEDGE_ID }); } },
    { label: 'AGENT cannot update a knowledge entry → 403', method: 'patch', path: `/api/v1/knowledge/${KNOWLEDGE_ID}`, as: 'AGENT', expect: 403, body: { answer: 'Nine to six.' } },
    { label: 'a non-member updating an entry gets 404', method: 'patch', path: `/api/v1/knowledge/${KNOWLEDGE_ID}`, as: 'NON_MEMBER', expect: 404, body: { answer: 'Nine to six.' } },
    { label: 'an entry that does not exist is 404 even for a member', method: 'patch', path: `/api/v1/knowledge/${KNOWLEDGE_ID}`, as: 'ADMIN', expect: 404, body: { answer: 'Nine to six.' }, prime: () => prismaMock.knowledgeEntry.findUnique.mockResolvedValue(null) },

    { label: 'AGENT cannot delete a knowledge entry → 403', method: 'delete', path: `/api/v1/knowledge/${KNOWLEDGE_ID}`, as: 'AGENT', expect: 403 },
    { label: 'a non-member deleting an entry gets 404', method: 'delete', path: `/api/v1/knowledge/${KNOWLEDGE_ID}`, as: 'NON_MEMBER', expect: 404 },
  ];

  it.each(cases)('$label', expectCase);
});

describe('conversation routes', () => {
  const cases: Case[] = [
    { label: 'AGENT creates a conversation (conversations:view)', method: 'post', path: `/api/v1/bots/${BOT_ID}/conversations`, as: 'AGENT', expect: 201, prime: () => { prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW); prismaMock.conversation.create.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID, status: 'ACTIVE', assignedAgentId: null, createdAt: new Date(), updatedAt: new Date() }); } },
    { label: 'a non-member creating a conversation gets 404', method: 'post', path: `/api/v1/bots/${BOT_ID}/conversations`, as: 'NON_MEMBER', expect: 404 },

    { label: 'AGENT lists a bot’s conversations', method: 'get', path: `/api/v1/bots/${BOT_ID}/conversations`, as: 'AGENT', expect: 200, prime: () => { prismaMock.bot.findFirst.mockResolvedValue(BOT_ROW); prismaMock.conversation.findMany.mockResolvedValue([]); } },
    { label: 'a non-member listing conversations gets 404', method: 'get', path: `/api/v1/bots/${BOT_ID}/conversations`, as: 'NON_MEMBER', expect: 404 },

    { label: 'AGENT reads a conversation (conversations:view)', method: 'get', path: `/api/v1/conversations/${CONVERSATION_ID}`, as: 'AGENT', expect: 200, prime: () => prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID, status: 'ACTIVE', assignedAgentId: null, createdAt: new Date(), updatedAt: new Date(), messages: [] }) },
    { label: 'a non-member reading a conversation gets 404', method: 'get', path: `/api/v1/conversations/${CONVERSATION_ID}`, as: 'NON_MEMBER', expect: 404 },
    { label: 'a conversation that does not exist is 404 even for a member', method: 'get', path: `/api/v1/conversations/${CONVERSATION_ID}`, as: 'AGENT', expect: 404, prime: () => prismaMock.conversation.findUnique.mockResolvedValue(null) },

    { label: 'AGENT replies to a conversation (conversations:reply)', method: 'post', path: `/api/v1/conversations/${CONVERSATION_ID}/messages`, as: 'AGENT', expect: 201, body: { content: 'On it.' }, prime: () => { prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID }); prismaMock.message.create.mockResolvedValue({ id: 'msg', conversationId: CONVERSATION_ID, role: 'USER', content: 'On it.', createdAt: new Date() }); aiMock.chat.mockResolvedValue({ status: 'success', response: 'Hello!', fallback_required: false }); } },
    { label: 'ADMIN replies to a conversation', method: 'post', path: `/api/v1/conversations/${CONVERSATION_ID}/messages`, as: 'ADMIN', expect: 201, body: { content: 'On it.' }, prime: () => { prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID }); prismaMock.message.create.mockResolvedValue({ id: 'msg', conversationId: CONVERSATION_ID, role: 'USER', content: 'On it.', createdAt: new Date() }); aiMock.chat.mockResolvedValue({ status: 'success', response: 'Hello!', fallback_required: false }); } },
    { label: 'a non-member replying gets 404', method: 'post', path: `/api/v1/conversations/${CONVERSATION_ID}/messages`, as: 'NON_MEMBER', expect: 404, body: { content: 'Let me in.' } },
  ];

  it.each(cases)('$label', expectCase);
});

describe('platform routes are platform-owner only', () => {
  const cases: Case[] = [
    { label: 'OWNER gets 403 on /admin/ai/status (workspace role ≠ platform role)', method: 'get', path: '/api/v1/admin/ai/status', as: 'OWNER', expect: 403 },
    { label: 'ADMIN gets 403 on /admin/ai/status', method: 'get', path: '/api/v1/admin/ai/status', as: 'ADMIN', expect: 403 },
    { label: 'AGENT gets 403 on /admin/ai/status', method: 'get', path: '/api/v1/admin/ai/status', as: 'AGENT', expect: 403 },
    { label: 'PLATFORM_OWNER reaches /admin/ai/status', method: 'get', path: '/api/v1/admin/ai/status', as: 'PLATFORM_OWNER', expect: 200, prime: () => aiMock.getAiStatus.mockResolvedValue({ status: 'ok' }) },

    { label: 'OWNER gets 403 on /platform/users', method: 'get', path: '/api/v1/platform/users', as: 'OWNER', expect: 403 },
    { label: 'PLATFORM_OWNER lists users', method: 'get', path: '/api/v1/platform/users', as: 'PLATFORM_OWNER', expect: 200, prime: () => prismaMock.user.findMany.mockResolvedValue([]) },

    { label: 'OWNER gets 403 on /platform/workspaces', method: 'get', path: '/api/v1/platform/workspaces', as: 'OWNER', expect: 403 },
    { label: 'PLATFORM_OWNER lists every workspace', method: 'get', path: '/api/v1/platform/workspaces', as: 'PLATFORM_OWNER', expect: 200, prime: () => prismaMock.workspace.findMany.mockResolvedValue([]) },

    { label: 'AGENT gets 403 on /platform/system', method: 'get', path: '/api/v1/platform/system', as: 'AGENT', expect: 403 },
    { label: 'PLATFORM_OWNER reads system status', method: 'get', path: '/api/v1/platform/system', as: 'PLATFORM_OWNER', expect: 200, prime: () => { prismaMock.user.count.mockResolvedValue(1); prismaMock.workspace.count.mockResolvedValue(1); prismaMock.bot.count.mockResolvedValue(0); prismaMock.conversation.count.mockResolvedValue(0); aiMock.getSystemStatus.mockResolvedValue({ status: 'ok' }); } },

    // --- AI catalog (Checkpoint 2). Added in Checkpoint 9 so the new surface is swept by
    // the same table as everything else. These routes sit behind the /platform namespace
    // guard, so a workspace role must be exactly as powerless here as it is on /platform/users.
    // The workspace identities below are all *members of a workspace* — the point is that
    // membership buys nothing in the platform domain.

    { label: 'OWNER gets 403 on /platform/providers', method: 'get', path: '/api/v1/platform/providers', as: 'OWNER', expect: 403 },
    { label: 'ADMIN gets 403 on /platform/providers', method: 'get', path: '/api/v1/platform/providers', as: 'ADMIN', expect: 403 },
    { label: 'PLATFORM_OWNER lists providers', method: 'get', path: '/api/v1/platform/providers', as: 'PLATFORM_OWNER', expect: 200, prime: () => prismaMock.aIProvider.findMany.mockResolvedValue([PROVIDER_ROW]) },

    { label: 'OWNER gets 403 on PATCH /platform/providers', method: 'patch', path: `/api/v1/platform/providers/${PROVIDER_ID}`, as: 'OWNER', expect: 403, body: { enabled: true } },
    { label: 'PLATFORM_OWNER updates a provider', method: 'patch', path: `/api/v1/platform/providers/${PROVIDER_ID}`, as: 'PLATFORM_OWNER', expect: 200, body: { enabled: true }, prime: () => { prismaMock.aIProvider.findUnique.mockResolvedValue({ id: PROVIDER_ID }); prismaMock.aIProvider.update.mockResolvedValue(PROVIDER_ROW); } },

    { label: 'ADMIN gets 403 on /platform/models', method: 'get', path: '/api/v1/platform/models', as: 'ADMIN', expect: 403 },
    { label: 'PLATFORM_OWNER lists models', method: 'get', path: '/api/v1/platform/models', as: 'PLATFORM_OWNER', expect: 200, prime: () => prismaMock.aIModel.findMany.mockResolvedValue([MODEL_ROW]) },

    { label: 'AGENT gets 403 on POST /platform/models', method: 'post', path: '/api/v1/platform/models', as: 'AGENT', expect: 403, body: { providerId: PROVIDER_ID, providerModelId: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini' } },
    { label: 'PLATFORM_OWNER creates a model', method: 'post', path: '/api/v1/platform/models', as: 'PLATFORM_OWNER', expect: 201, body: { providerId: PROVIDER_ID, providerModelId: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini' }, prime: () => { prismaMock.aIProvider.findUnique.mockResolvedValue({ id: PROVIDER_ID }); prismaMock.aIModel.findUnique.mockResolvedValue(null); prismaMock.aIModel.create.mockResolvedValue(MODEL_ROW); } },

    { label: 'OWNER gets 403 on PATCH /platform/models', method: 'patch', path: `/api/v1/platform/models/${MODEL_ID}`, as: 'OWNER', expect: 403, body: { enabled: true } },
    { label: 'PLATFORM_OWNER updates a model', method: 'patch', path: `/api/v1/platform/models/${MODEL_ID}`, as: 'PLATFORM_OWNER', expect: 200, body: { enabled: true }, prime: () => { prismaMock.aIModel.findUnique.mockResolvedValue({ id: MODEL_ID }); prismaMock.aIModel.update.mockResolvedValue(MODEL_ROW); } },

    { label: 'AGENT gets 403 on DELETE /platform/models', method: 'delete', path: `/api/v1/platform/models/${MODEL_ID}`, as: 'AGENT', expect: 403 },
    { label: 'PLATFORM_OWNER deletes an unreferenced model', method: 'delete', path: `/api/v1/platform/models/${MODEL_ID}`, as: 'PLATFORM_OWNER', expect: 200, prime: () => { prismaMock.aIModel.findUnique.mockResolvedValue({ ...MODEL_ROW, _count: { bots: 0 } }); prismaMock.aIModel.delete.mockResolvedValue(MODEL_ROW); } },
  ];

  it.each(cases)('$label', expectCase);
});

describe('collection routes: authenticated, deliberately unscoped', () => {
  const cases: Case[] = [
    { label: 'any authenticated user reads their own profile', method: 'get', path: '/api/v1/users/me', as: 'AGENT', expect: 200, prime: () => prismaMock.user.findUnique.mockResolvedValue({ id: USER.id, name: 'Caller', email: USER.email, platformRole: 'USER', createdAt: new Date(), updatedAt: new Date() }) },
    { label: 'any authenticated user lists their workspaces', method: 'get', path: '/api/v1/workspaces', as: 'AGENT', expect: 200, prime: () => prismaMock.workspace.findMany.mockResolvedValue([WORKSPACE_ROW]) },
    { label: 'any authenticated user creates a workspace (becoming its OWNER)', method: 'post', path: '/api/v1/workspaces', as: 'AGENT', expect: 201, body: { name: 'New' }, prime: () => prismaMock.workspace.create.mockResolvedValue(WORKSPACE_ROW) },
  ];

  it.each(cases)('$label', expectCase);

  it('GET /workspaces filters by membership in the query itself — the list cannot leak another tenant', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue(memberRow('AGENT'));
    prismaMock.workspace.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/v1/workspaces')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    // The isolation lives in the where-clause, not in post-filtering of the results.
    expect(prismaMock.workspace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { members: { some: { userId: USER.id } } } })
    );
  });
});

describe('unauthenticated requests are rejected before any authorization runs', () => {
  const paths = [
    ['get', '/api/v1/users/me'],
    ['get', '/api/v1/workspaces'],
    ['post', '/api/v1/workspaces'],
    ['get', `/api/v1/workspaces/${WORKSPACE_ID}`],
    ['get', `/api/v1/workspaces/${WORKSPACE_ID}/members`],
    ['post', `/api/v1/workspaces/${WORKSPACE_ID}/bots`],
    ['get', `/api/v1/bots/${BOT_ID}`],
    ['patch', `/api/v1/bots/${BOT_ID}`],
    ['delete', `/api/v1/bots/${BOT_ID}`],
    ['get', `/api/v1/bots/${BOT_ID}/knowledge`],
    ['post', `/api/v1/bots/${BOT_ID}/knowledge`],
    ['patch', `/api/v1/knowledge/${KNOWLEDGE_ID}`],
    ['post', `/api/v1/bots/${BOT_ID}/conversations`],
    ['get', `/api/v1/conversations/${CONVERSATION_ID}`],
    ['post', `/api/v1/conversations/${CONVERSATION_ID}/messages`],
    ['get', '/api/v1/admin/ai/status'],
    ['get', '/api/v1/platform/users'],
    ['get', '/api/v1/platform/workspaces'],
    ['get', '/api/v1/platform/system'],
    ['patch', `/api/v1/bots/${BOT_ID}/model`],
    ['get', '/api/v1/ai/models'],
    ['get', '/api/v1/platform/providers'],
    ['patch', `/api/v1/platform/providers/${PROVIDER_ID}`],
    ['get', '/api/v1/platform/models'],
    ['post', '/api/v1/platform/models'],
    ['patch', `/api/v1/platform/models/${MODEL_ID}`],
    ['delete', `/api/v1/platform/models/${MODEL_ID}`],
  ] as const;

  it.each(paths)('%s %s → 401', async (method, path) => {
    const res = await request(app)[method](path);

    expect(res.status).toBe(401);
    // Nothing was resolved and nothing was written: authentication gates first.
    expect(prismaMock.workspaceMember.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.bot.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeEntry.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.conversation.findUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });
});

// ---------------------------------------------------------------------------------------
// Checkpoint 9 — immutability and projection sweeps
// ---------------------------------------------------------------------------------------

/**
 * `providerModelId` and `slug` bind a catalog row to something outside the database: an
 * adapter in the Python service, and the provider-native id an already-assigned bot will
 * call. Editing either through the API would silently repoint live traffic, so each is
 * write-once and every attempt is a **400 rather than a stripped 200** — a caller that
 * believes it changed the id must not be told the update succeeded.
 *
 * The mutation-proof half of this sweep is the `expectCase` invariant: a 400 that had
 * already reached a write would fail `expectNoWrites`, so "rejected" means rejected *before*
 * the mutation, not rolled back after it.
 */
describe('catalog identity fields are write-once', () => {
  const cases: Case[] = [
    // Identity fields of the row being edited.
    { label: 'PATCH /platform/models rejects providerModelId alone → 400', method: 'patch', path: `/api/v1/platform/models/${MODEL_ID}`, as: 'PLATFORM_OWNER', expect: 400, body: { providerModelId: 'openai/gpt-4o' } },
    { label: 'PATCH /platform/models rejects providerModelId alongside an allowed field → 400', method: 'patch', path: `/api/v1/platform/models/${MODEL_ID}`, as: 'PLATFORM_OWNER', expect: 400, body: { displayName: 'Renamed', providerModelId: 'openai/gpt-4o' } },
    { label: 'PATCH /platform/providers rejects slug alone → 400', method: 'patch', path: `/api/v1/platform/providers/${PROVIDER_ID}`, as: 'PLATFORM_OWNER', expect: 400, body: { slug: 'openai' } },
    { label: 'PATCH /platform/providers rejects slug alongside an allowed field → 400', method: 'patch', path: `/api/v1/platform/providers/${PROVIDER_ID}`, as: 'PLATFORM_OWNER', expect: 400, body: { name: 'Renamed', slug: 'openai' } },

    // The catalog-bypass attempt: a provider-native id sent where a catalog uuid belongs.
    // Rejected for every role that could otherwise write, which is what makes S4 hold
    // independently of who is calling.
    { label: 'OWNER cannot assign a provider-native id in place of a catalog uuid → 400', method: 'patch', path: `/api/v1/bots/${BOT_ID}/model`, as: 'OWNER', expect: 400, body: { aiModelId: 'openai/gpt-4o-mini' } },
    { label: 'ADMIN cannot assign a provider-native id in place of a catalog uuid → 400', method: 'patch', path: `/api/v1/bots/${BOT_ID}/model`, as: 'ADMIN', expect: 400, body: { aiModelId: 'openai/gpt-4o-mini' } },
    { label: 'a non-uuid model id is 400 even for a platform owner', method: 'patch', path: `/api/v1/bots/${BOT_ID}/model`, as: 'PLATFORM_OWNER', expect: 400, body: { aiModelId: 'openai/gpt-4o-mini' } },
  ];

  it.each(cases)('$label', expectCase);
});

/**
 * The provider-native id must not reach a workspace at all — not through the catalog read,
 * and not through the bot it is assigned to. Asserting only on the response body would pin
 * today's mapper; asserting on the `select` pins the reason, so a future field added to the
 * projection fails here rather than shipping the id to every tenant.
 */
describe('providerModelId never reaches a workspace-facing projection', () => {
  it('the catalog read selects id, displayName and the provider label — nothing else', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue(memberRow('AGENT'));
    prismaMock.user.findUnique.mockResolvedValue({ platformRole: 'USER' });
    prismaMock.aIModel.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/v1/ai/models')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(prismaMock.aIModel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          displayName: true,
          provider: { select: { slug: true, name: true } },
        },
      })
    );
  });

  it('the catalog read carries no provider-native id in its payload', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue(memberRow('AGENT'));
    prismaMock.user.findUnique.mockResolvedValue({ platformRole: 'USER' });
    // The mock returns the *selected* shape, not the table row: if the service ever asked
    // for `providerModelId`, this fixture would have to change, and the assertion below
    // would fail on the key rather than pass on a coincidence.
    prismaMock.aIModel.findMany.mockResolvedValue([
      { id: MODEL_ID, displayName: 'GPT-4o mini', provider: { slug: 'openrouter', name: 'OpenRouter' } },
    ]);

    const res = await request(app)
      .get('/api/v1/ai/models')
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['displayName', 'id', 'provider']);
    expect(JSON.stringify(res.body)).not.toContain('openai/gpt-4o-mini');
  });

  it('a bot read projects its model without the provider-native id', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue(memberRow('OWNER'));
    prismaMock.user.findUnique.mockResolvedValue({ platformRole: 'USER' });
    // The middleware resolves the workspace through the bot before the handler runs.
    prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
    prismaMock.bot.findFirst.mockResolvedValue({
      ...BOT_ROW,
      aiModelId: MODEL_ID,
      aiModel: {
        id: MODEL_ID,
        displayName: 'GPT-4o mini',
        enabled: true,
        provider: { slug: 'openrouter', name: 'OpenRouter', enabled: true },
      },
    });

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}`)
      .set('Authorization', authHeader());

    expect(res.status).toBe(200);
    expect(prismaMock.bot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          aiModel: {
            select: {
              id: true,
              displayName: true,
              enabled: true,
              provider: { select: { slug: true, name: true, enabled: true } },
            },
          },
        },
      })
    );
    const projected = res.body.data.aiModel;
    expect(Object.keys(projected).sort()).toEqual(['displayName', 'enabled', 'id', 'provider']);
    expect(JSON.stringify(res.body)).not.toContain('openai/gpt-4o-mini');
  });
});
