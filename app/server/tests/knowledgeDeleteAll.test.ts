import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/**
 * Checkpoint 8 — "delete all FAQ entries" and its blast radius (section 18).
 *
 * A bot's vectors come from two places and share one pgvector table: hand-written FAQ
 * entries (whose `source_id` is the entry id) and uploaded documents (whose `source_id` is
 * a `knowledge_sources` row id). Nothing in the schema separates them beyond that column.
 *
 * The button says "delete all FAQ entries". The one-call implementation of that,
 * `deleteBotKnowledge(botId)`, deletes every vector the bot owns — so it also took the
 * uploaded documents': their `knowledge_chunks_meta` rows survived in this database, the
 * documents stayed listed in the UI, and every one of them had quietly stopped being
 * searchable, with nothing anywhere recording why. These tests pin the scoped version.
 *
 * The distinction is only observable through which AI call is made, so that is what is
 * asserted: the entry ids, and never the bot id.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  bot: { findUnique: vi.fn(), findFirst: vi.fn() },
  knowledgeEntry: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

const aiMock = vi.hoisted(() => ({
  bulkDeleteSourceVectors: vi.fn(),
  deleteBotKnowledge: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'owner@example.com' };
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const ENTRY_A = 'entry-aaaa';
const ENTRY_B = 'entry-bbbb';

const authHeader = (): string => `Bearer ${signToken({ sub: USER.id, email: USER.email })}`;

const deleteAll = () =>
  request(app)
    .delete(`/api/v1/bots/${BOT_ID}/knowledge`)
    .set('Authorization', authHeader());

beforeEach(() => {
  vi.resetAllMocks();

  // Scope resolution: the caller is an OWNER of the workspace that owns this bot.
  prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
  prismaMock.workspaceMember.findUnique.mockResolvedValue({ role: 'OWNER' });
  prismaMock.user.findUnique.mockResolvedValue({ platformRole: 'USER' });
  // `deleteAllKnowledge` re-asserts access through `getBotById`, which reads the row itself
  // rather than only its workspace — a `null` here is a 404, not a 200 with no work done.
  prismaMock.bot.findFirst.mockResolvedValue({
    id: BOT_ID,
    name: 'Helper',
    description: null,
    workspaceId: WORKSPACE_ID,
  });
  prismaMock.knowledgeEntry.findMany.mockResolvedValue([{ id: ENTRY_A }, { id: ENTRY_B }]);
  prismaMock.knowledgeEntry.deleteMany.mockResolvedValue({ count: 2 });
  aiMock.bulkDeleteSourceVectors.mockResolvedValue({ chunks_deleted: 5 });
});

describe('DELETE /bots/:botId/knowledge', () => {
  it('deletes the FAQ entries’ own vectors, not the bot’s entire index', async () => {
    const res = await deleteAll();

    expect(res.status).toBe(200);
    expect(aiMock.bulkDeleteSourceVectors).toHaveBeenCalledWith(BOT_ID, [ENTRY_A, ENTRY_B]);
    // The regression itself. This call also removes the uploaded documents' vectors, and
    // no error would be raised — the loss is silent and permanent, since a vector with no
    // `source_id` left in Prisma can never be enumerated or deleted.
    expect(aiMock.deleteBotKnowledge).not.toHaveBeenCalled();
  });

  it('reads the entry ids before deleting the rows', async () => {
    // The ids are the only handle on those vectors. Read after the delete and there is
    // nothing left to derive them from, which is exactly how an orphan becomes permanent.
    await deleteAll();

    expect(prismaMock.knowledgeEntry.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.knowledgeEntry.deleteMany.mock.invocationCallOrder[0] as number
    );
  });

  it('still removes the entries when the vector deletion fails', async () => {
    // The user asked for the FAQs to be gone, and they are gone from this database. Failing
    // the request would report an error for work that succeeded — and a retry would find no
    // entries to name, so the orphaned vectors could never be cleaned up at all.
    aiMock.bulkDeleteSourceVectors.mockRejectedValue(new Error('AI service is down'));

    const res = await deleteAll();

    expect(res.status).toBe(200);
    expect(prismaMock.knowledgeEntry.deleteMany).toHaveBeenCalledWith({ where: { botId: BOT_ID } });
  });

  it('makes no AI call at all when the bot has no entries', async () => {
    // A bot with no FAQs still has its uploaded documents. Calling the AI service here
    // would be a wipe triggered by a no-op — the worst possible failure mode for an
    // endpoint whose button says "delete all FAQ entries".
    prismaMock.knowledgeEntry.findMany.mockResolvedValue([]);

    const res = await deleteAll();

    expect(res.status).toBe(200);
    expect(aiMock.bulkDeleteSourceVectors).not.toHaveBeenCalled();
    expect(aiMock.deleteBotKnowledge).not.toHaveBeenCalled();
  });

  it('forbids a caller without knowledge:manage', async () => {
    prismaMock.workspaceMember.findUnique.mockResolvedValue({ role: 'AGENT' });

    const res = await deleteAll();

    expect(res.status).toBe(403);
    expect(prismaMock.knowledgeEntry.deleteMany).not.toHaveBeenCalled();
    expect(aiMock.bulkDeleteSourceVectors).not.toHaveBeenCalled();
  });
});
