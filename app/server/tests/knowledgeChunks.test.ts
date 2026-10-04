/**
 * Tests for knowledge chunk CRUD, bulk operations, stats, and retrieval testing
 * (Checkpoint 5).
 *
 * The load-bearing claims:
 *
 * 1. **The vector is written before the mirror row, on every mutation.** Edit, delete and
 *    bulk all do their AI call first. The tests assert the *order*, not just that both
 *    happened: a delete that removed the row first would leave a vector nothing can
 *    enumerate, and an edit whose AI call failed after the row was written would leave the
 *    row claiming content the embeddings do not reflect.
 * 2. **A failed re-embed changes nothing.** The 502 path is asserted to leave the Prisma
 *    row untouched, which is the plan's section 9.2 guarantee.
 * 3. **The chunk list's filters are exactly the ones asked for.** `?enabled=false` must
 *    filter for disabled chunks; the intuitive `z.coerce.boolean()` would map the string
 *    `"false"` to `true` and quietly return the opposite set.
 * 4. **A bulk operation may not touch another bot's chunks.** The AI service would treat a
 *    foreign id as a no-op and still report success, so the ownership check has to happen
 *    server-side — and the test proves a mixed batch writes nothing.
 * 5. **Editing with identical content does not re-embed.** A provider call and a version
 *    bump for a change that never happened is a silent cost.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  bot: { findUnique: vi.fn(), findFirst: vi.fn() },
  knowledgeChunk: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  knowledgeSource: {
    findMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
    // Present so a chunk deletion can be asserted not to reach the source at all. A
    // missing mock would make that assertion fail for the wrong reason — as an
    // "undefined is not a spy" error rather than as the cascade bug it is looking for.
    delete: vi.fn(),
    update: vi.fn(),
  },
}));

const aiMock = vi.hoisted(() => ({
  reEmbedChunk: vi.fn(),
  toggleChunkEnabled: vi.fn(),
  deleteChunkVector: vi.fn(),
  bulkToggleChunks: vi.fn(),
  bulkDeleteChunks: vi.fn(),
  searchVectors: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const OWNER_USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'owner@example.com' };
const AGENT_USER = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'agent@example.com' };
const STRANGER_USER = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', email: 'stranger@example.com' };

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const SOURCE_ID = '33333333-3333-3333-3333-333333333333';
const CHUNK_ID = '44444444-4444-4444-4444-444444444444';
const CHUNK_ID_2 = '55555555-5555-5555-5555-555555555555';
const FOREIGN_CHUNK_ID = '66666666-6666-6666-6666-666666666666';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

const memberRecord = (userId: string, role: string) => ({
  id: `member-${userId}`,
  userId,
  workspaceId: WORKSPACE_ID,
  role,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const botRecord = () => ({
  id: BOT_ID,
  name: 'Support Bot',
  description: null,
  workspaceId: WORKSPACE_ID,
  aiModelId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const chunkRecord = (overrides: Record<string, unknown> = {}) => ({
  id: CHUNK_ID,
  sourceId: SOURCE_ID,
  botId: BOT_ID,
  content: 'Refunds take five business days.',
  chunkIndex: 0,
  pageNumber: 3,
  section: null,
  topic: null,
  enabled: true,
  version: 1,
  embeddingModel: 'all-MiniLM-L6-v2',
  embeddingDimension: 384,
  lastEmbeddedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
  source: { id: SOURCE_ID, filename: 'handbook.pdf' },
  ...overrides,
});

/** Drive membership lookups from a map of userId → role. */
const setMemberships = (map: Record<string, string | null>): void => {
  prismaMock.workspaceMember.findUnique.mockImplementation(
    (args: { where?: { userId_workspaceId?: { userId?: string } } }) => {
      const userId = args?.where?.userId_workspaceId?.userId;
      const role = userId ? map[userId] : null;
      return Promise.resolve(role ? memberRecord(userId as string, role) : null);
    }
  );
};

beforeEach(() => {
  vi.clearAllMocks();

  prismaMock.bot.findFirst.mockResolvedValue(botRecord());
  // The `knowledgeChunk` scope resolver reads only the owning workspace; the `bot` scope
  // resolver does the same for bot-scoped routes.
  prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
  prismaMock.knowledgeChunk.findUnique.mockResolvedValue({
    bot: { workspaceId: WORKSPACE_ID },
  });
  prismaMock.knowledgeChunk.findFirst.mockResolvedValue(chunkRecord());
  // Two callers share `findMany`: the list route (no id filter) and the bulk ownership
  // check (`where.id.in`). Echoing the requested ids back for the latter keeps the mock
  // honest — a fixed one-row array would make every multi-id batch fail the count
  // comparison, which is a fixture artefact rather than the behaviour under test.
  prismaMock.knowledgeChunk.findMany.mockImplementation(
    (args: { where?: { id?: { in?: string[] } } }) => {
      const ids = args?.where?.id?.in;
      return Promise.resolve(ids ? ids.map((id) => ({ id })) : [chunkRecord()]);
    }
  );
  prismaMock.knowledgeChunk.count.mockResolvedValue(1);
  prismaMock.knowledgeChunk.update.mockImplementation(
    (args: { data?: Record<string, unknown> }) => Promise.resolve(chunkRecord(args?.data ?? {}))
  );
  prismaMock.knowledgeChunk.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.knowledgeChunk.delete.mockResolvedValue(chunkRecord());
  prismaMock.knowledgeChunk.deleteMany.mockResolvedValue({ count: 1 });
  prismaMock.knowledgeSource.findMany.mockResolvedValue([
    { id: SOURCE_ID, filename: 'handbook.pdf' },
  ]);
  prismaMock.knowledgeSource.count.mockResolvedValue(1);
  prismaMock.knowledgeSource.groupBy.mockResolvedValue([
    { status: 'PROCESSED', _count: { _all: 1 } },
  ]);

  aiMock.reEmbedChunk.mockResolvedValue({
    success: true,
    chunk_id: CHUNK_ID,
    embedding_model: 'all-MiniLM-L6-v2',
    embedding_dimension: 384,
  });
  aiMock.toggleChunkEnabled.mockResolvedValue({ success: true });
  aiMock.deleteChunkVector.mockResolvedValue({ success: true, deleted: true });
  aiMock.bulkToggleChunks.mockResolvedValue({ success: true, updated: 1 });
  aiMock.bulkDeleteChunks.mockResolvedValue({ success: true, deleted: 1 });
  aiMock.searchVectors.mockResolvedValue({
    query: 'refunds',
    results: [
      {
        id: CHUNK_ID,
        content: 'Refunds take five business days.',
        score: 0.87,
        metadata: { page_number: 3, source_id: SOURCE_ID },
      },
    ],
  });

  setMemberships({ [OWNER_USER.id]: 'OWNER', [AGENT_USER.id]: 'AGENT' });
});

// --------------------------------------------------------------------------------------
// List
// --------------------------------------------------------------------------------------

describe('GET /bots/:botId/knowledge-chunks', () => {
  it('returns the chunks with pagination metadata', async () => {
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(res.body.data.chunks).toHaveLength(1);
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('applies the coerced page and limit to the query it runs', async () => {
    // Express's `req.query` is a getter, so `validate` cannot write its parsed result
    // back; the controller re-parses. If it did not, `skip` would be `NaN` and the page
    // would silently be the first one — with pagination metadata still claiming page 3.
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks?page=3&limit=5`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(res.body.data.pagination.page).toBe(3);
    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 })
    );
  });

  it('filters for disabled chunks when asked for enabled=false', async () => {
    // `z.coerce.boolean()` would make this `true` — any non-empty string is truthy — and
    // the request would return the exact opposite of what it asked for.
    await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks?enabled=false`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ enabled: false }),
      })
    );
  });

  it('omits the enabled filter entirely when it is not supplied', async () => {
    await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks`)
      .set('Authorization', authHeader(OWNER_USER));

    const where = prismaMock.knowledgeChunk.findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('enabled');
  });

  it('combines the search, source, and enabled filters', async () => {
    await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks?search=refund&sourceId=${SOURCE_ID}&enabled=true`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          botId: BOT_ID,
          sourceId: SOURCE_ID,
          enabled: true,
          content: { contains: 'refund', mode: 'insensitive' },
        },
      })
    );
  });

  it('treats a cleared search box as no filter rather than a validation error', async () => {
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks?search=`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(prismaMock.knowledgeChunk.findMany.mock.calls[0][0].where).not.toHaveProperty('content');
  });

  it('orders by chunk index with a tiebreaker, so pages cannot repeat or skip a row', async () => {
    // `chunkIndex` restarts at 0 for every source, so it is not unique within a bot. A
    // single-key order would leave tied rows in an order Postgres may vary per query.
    await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ chunkIndex: 'asc' }, { id: 'asc' }] })
    );
  });

  it('lets an AGENT list chunks — reading knowledge is granted to every role', async () => {
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks`)
      .set('Authorization', authHeader(AGENT_USER));

    expect(res.status).toBe(200);
  });

  it('rejects a limit above the cap', async () => {
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks?limit=500`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(400);
  });

  it('gives a non-member 404 rather than 403', async () => {
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks`)
      .set('Authorization', authHeader(STRANGER_USER));

    expect(res.status).toBe(404);
  });
});

// --------------------------------------------------------------------------------------
// Read one
// --------------------------------------------------------------------------------------

describe('GET /knowledge-chunks/:chunkId', () => {
  it('returns the chunk with its source details', async () => {
    const res = await request(app)
      .get(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(res.body.data.source).toEqual({ id: SOURCE_ID, filename: 'handbook.pdf' });
  });

  it('scopes the lookup to the caller’s workspaces, so another tenant’s chunk is a 404', async () => {
    // The filter is what makes cross-tenant access impossible: an unprimed `findFirst`
    // result would not prove anything, so this asserts the where clause itself.
    await request(app)
      .get(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(prismaMock.knowledgeChunk.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: CHUNK_ID,
          bot: { workspace: { members: { some: { userId: OWNER_USER.id } } } },
        },
      })
    );
  });

  it('is a 404 when the chunk does not exist', async () => {
    prismaMock.knowledgeChunk.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(404);
  });

  it('rejects a non-uuid chunk id before reaching the service', async () => {
    const res = await request(app)
      .get('/api/v1/knowledge-chunks/not-a-uuid')
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(400);
    expect(prismaMock.knowledgeChunk.findFirst).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------------------
// Edit — re-embedding
// --------------------------------------------------------------------------------------

describe('PATCH /knowledge-chunks/:chunkId', () => {
  it('re-embeds through the AI service and records the new embedding metadata', async () => {
    const res = await request(app)
      .patch(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ content: 'Refunds now take two business days.' });

    expect(res.status).toBe(200);
    expect(aiMock.reEmbedChunk).toHaveBeenCalledWith(
      BOT_ID,
      CHUNK_ID,
      'Refunds now take two business days.'
    );
    expect(prismaMock.knowledgeChunk.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: 'Refunds now take two business days.',
          version: { increment: 1 },
          embeddingModel: 'all-MiniLM-L6-v2',
          embeddingDimension: 384,
        }),
      })
    );
  });

  it('leaves the row untouched when re-embedding fails', async () => {
    // Section 9.2: the old content and its embedding must stay consistent. The update is
    // never issued, so there is no window in which the row describes a vector that does
    // not exist.
    const { AppError } = await import('../src/utils/errors.js');
    aiMock.reEmbedChunk.mockRejectedValue(new AppError('AI service unavailable', 502));

    const res = await request(app)
      .patch(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ content: 'New text.' });

    expect(res.status).toBe(502);
    expect(prismaMock.knowledgeChunk.update).not.toHaveBeenCalled();
  });

  it('does not re-embed when the content is unchanged', async () => {
    // The chunk already holds this text. Re-embedding it would spend a provider call and
    // bump `version` for an edit that changed nothing.
    const res = await request(app)
      .patch(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ content: 'Refunds take five business days.' });

    expect(res.status).toBe(200);
    expect(aiMock.reEmbedChunk).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChunk.update).not.toHaveBeenCalled();
  });

  it('toggles without re-embedding and without bumping the version', async () => {
    const res = await request(app)
      .patch(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(aiMock.reEmbedChunk).not.toHaveBeenCalled();
    expect(aiMock.toggleChunkEnabled).toHaveBeenCalledWith(BOT_ID, CHUNK_ID, false);

    const data = prismaMock.knowledgeChunk.update.mock.calls[0][0].data;
    expect(data).toEqual({ enabled: false });
    expect(data).not.toHaveProperty('version');
  });

  it('does both in one request when content and enabled arrive together', async () => {
    const res = await request(app)
      .patch(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ content: 'Corrected text.', enabled: false });

    expect(res.status).toBe(200);
    expect(aiMock.reEmbedChunk).toHaveBeenCalled();
    expect(aiMock.toggleChunkEnabled).toHaveBeenCalledWith(BOT_ID, CHUNK_ID, false);
    expect(prismaMock.knowledgeChunk.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ content: 'Corrected text.', enabled: false }),
      })
    );
  });

  it('writes the vector before the row, so a failure cannot leave them disagreeing', async () => {
    // Order is the whole claim: the AI call is what makes the change visible to
    // retrieval, and the row is the mirror. Reversing them means a failed AI call leaves
    // a row describing a state the vectors do not have.
    await request(app)
      .patch(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ content: 'Corrected text.' });

    expect(aiMock.reEmbedChunk.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.knowledgeChunk.update.mock.invocationCallOrder[0] as number
    );
  });

  it('rejects empty content', async () => {
    const res = await request(app)
      .patch(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({ content: '   ' });

    expect(res.status).toBe(400);
    expect(aiMock.reEmbedChunk).not.toHaveBeenCalled();
  });

  it('rejects a body that carries neither field', async () => {
    const res = await request(app)
      .patch(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER))
      .send({});

    expect(res.status).toBe(400);
  });

  it('forbids an AGENT from editing', async () => {
    const res = await request(app)
      .patch(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(AGENT_USER))
      .send({ content: 'Rewritten.' });

    expect(res.status).toBe(403);
    expect(aiMock.reEmbedChunk).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChunk.update).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------------------
// Delete
// --------------------------------------------------------------------------------------

describe('DELETE /knowledge-chunks/:chunkId', () => {
  it('deletes the vector, then the row', async () => {
    const res = await request(app)
      .delete(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(aiMock.deleteChunkVector).toHaveBeenCalledWith(BOT_ID, CHUNK_ID);
    expect(prismaMock.knowledgeChunk.delete).toHaveBeenCalledWith({ where: { id: CHUNK_ID } });
    expect(aiMock.deleteChunkVector.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.knowledgeChunk.delete.mock.invocationCallOrder[0] as number
    );
  });

  it('keeps the row when the vector cannot be deleted', async () => {
    // Deleting the row first would orphan the vector: `chunkId` is the only thing that
    // identifies it, and it would be gone. A 502 with the row intact is retryable.
    const { AppError } = await import('../src/utils/errors.js');
    aiMock.deleteChunkVector.mockRejectedValue(new AppError('AI service unavailable', 502));

    const res = await request(app)
      .delete(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(502);
    expect(prismaMock.knowledgeChunk.delete).not.toHaveBeenCalled();
  });

  it('deletes the row when the vector is already gone, rather than reporting an error', async () => {
    // The AI service answers 404 when no vector matches the id. The caller asked for the
    // chunk to be gone and it is, so failing here would leave the row permanently
    // undeletable: every retry would fetch the same row, call the same endpoint, and get
    // the same 404 back (section 18.13).
    const { AIServiceError } = await import('../src/utils/errors.js');
    aiMock.deleteChunkVector.mockRejectedValue(
      new AIServiceError('Chunk not found.', { status: 404, detail: 'Chunk not found.' })
    );

    const res = await request(app)
      .delete(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(prismaMock.knowledgeChunk.delete).toHaveBeenCalledWith({ where: { id: CHUNK_ID } });
  });

  it('does not absorb a 502, because the vector may still exist', async () => {
    // The distinction the status alone cannot carry. A 404 is proof the vector is absent;
    // a timeout or a 5xx is not, and deleting the row then would strand a vector that
    // nothing can enumerate or ever delete.
    const { AIServiceError } = await import('../src/utils/errors.js');
    aiMock.deleteChunkVector.mockRejectedValue(
      new AIServiceError('The AI service is currently unavailable. Please try again later.', {
        status: 503,
      })
    );

    const res = await request(app)
      .delete(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(502);
    expect(prismaMock.knowledgeChunk.delete).not.toHaveBeenCalled();
  });

  it('leaves the source in place, so a document with no chunks is still a document', async () => {
    // The last chunk of a source is a normal chunk deletion (section 18.14). Cascading
    // upward — "no chunks, so no source" — would silently delete a document the user
    // uploaded, and the cascade only runs one way: a source deletion removes its chunks,
    // never the reverse. The source row survives with `_count.chunks` at zero.
    const res = await request(app)
      .delete(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(prismaMock.knowledgeSource.delete).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeSource.update).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChunk.deleteMany).not.toHaveBeenCalled();
  });

  it('forbids an AGENT from deleting', async () => {
    const res = await request(app)
      .delete(`/api/v1/knowledge-chunks/${CHUNK_ID}`)
      .set('Authorization', authHeader(AGENT_USER));

    expect(res.status).toBe(403);
    expect(aiMock.deleteChunkVector).not.toHaveBeenCalled();
  });

  it('is a 404 for a chunk in another workspace', async () => {
    prismaMock.knowledgeChunk.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/v1/knowledge-chunks/${FOREIGN_CHUNK_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(404);
    expect(aiMock.deleteChunkVector).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------------------
// Bulk
// --------------------------------------------------------------------------------------

describe('POST /bots/:botId/knowledge-chunks/bulk', () => {
  const bulk = (body: unknown, user = OWNER_USER) =>
    request(app)
      .post(`/api/v1/bots/${BOT_ID}/knowledge-chunks/bulk`)
      .set('Authorization', authHeader(user))
      .send(body);

  it('enables the named chunks in both stores', async () => {
    const res = await bulk({ action: 'enable', chunkIds: [CHUNK_ID, CHUNK_ID_2] });

    expect(res.status).toBe(200);
    expect(res.body.data.affected).toBe(1);
    expect(aiMock.bulkToggleChunks).toHaveBeenCalledWith(BOT_ID, [CHUNK_ID, CHUNK_ID_2], true);
    expect(prismaMock.knowledgeChunk.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { enabled: true } })
    );
  });

  it('disables them when asked', async () => {
    await bulk({ action: 'disable', chunkIds: [CHUNK_ID] });

    expect(aiMock.bulkToggleChunks).toHaveBeenCalledWith(BOT_ID, [CHUNK_ID], false);
    expect(prismaMock.knowledgeChunk.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { enabled: false } })
    );
  });

  it('deletes them from both stores', async () => {
    const res = await bulk({ action: 'delete', chunkIds: [CHUNK_ID, CHUNK_ID_2] });

    expect(res.status).toBe(200);
    expect(aiMock.bulkDeleteChunks).toHaveBeenCalledWith(BOT_ID, [CHUNK_ID, CHUNK_ID_2]);
    expect(prismaMock.knowledgeChunk.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [CHUNK_ID, CHUNK_ID_2] }, botId: BOT_ID },
    });
    expect(aiMock.bulkToggleChunks).not.toHaveBeenCalled();
  });

  it('refuses the whole batch when one id belongs to another bot', async () => {
    // The AI service scopes by bot_id, so a foreign id is a no-op there — and a response
    // that reported "2 chunks disabled" while one was silently skipped is a lie the caller
    // cannot detect. Nothing may be written.
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([{ id: CHUNK_ID }]);

    const res = await bulk({ action: 'disable', chunkIds: [CHUNK_ID, FOREIGN_CHUNK_ID] });

    expect(res.status).toBe(400);
    expect(aiMock.bulkToggleChunks).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChunk.updateMany).not.toHaveBeenCalled();
  });

  it('verifies ownership against this bot before doing anything', async () => {
    await bulk({ action: 'enable', chunkIds: [CHUNK_ID] });

    expect(prismaMock.knowledgeChunk.findMany).toHaveBeenCalledWith({
      where: { id: { in: [CHUNK_ID] }, botId: BOT_ID },
      select: { id: true },
    });
  });

  it('collapses duplicate ids instead of failing the ownership check', async () => {
    // A double-selected row is a UI slip. If the duplicates were sent through, the
    // ownership count would be short by one and the request would 400 for no reason.
    prismaMock.knowledgeChunk.findMany.mockResolvedValue([{ id: CHUNK_ID }]);

    const res = await bulk({ action: 'enable', chunkIds: [CHUNK_ID, CHUNK_ID] });

    expect(res.status).toBe(200);
    expect(aiMock.bulkToggleChunks).toHaveBeenCalledWith(BOT_ID, [CHUNK_ID], true);
  });

  it('rejects more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) =>
      `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`
    );

    const res = await bulk({ action: 'delete', chunkIds: ids });

    expect(res.status).toBe(400);
    expect(aiMock.bulkDeleteChunks).not.toHaveBeenCalled();
  });

  it('rejects an empty id list', async () => {
    const res = await bulk({ action: 'delete', chunkIds: [] });

    expect(res.status).toBe(400);
  });

  it('rejects an unknown action', async () => {
    const res = await bulk({ action: 'purge', chunkIds: [CHUNK_ID] });

    expect(res.status).toBe(400);
  });

  it('forbids an AGENT from running a bulk operation', async () => {
    const res = await bulk({ action: 'delete', chunkIds: [CHUNK_ID] }, AGENT_USER);

    expect(res.status).toBe(403);
    expect(aiMock.bulkDeleteChunks).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeChunk.deleteMany).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------------------
// Stats
// --------------------------------------------------------------------------------------

describe('GET /bots/:botId/knowledge-chunks/stats', () => {
  it('reports the counts and every source status, zero-filled', async () => {
    prismaMock.knowledgeChunk.count
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(7); // enabled

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks/stats`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      totalChunks: 10,
      enabledChunks: 7,
      disabledChunks: 3,
      totalSources: 1,
    });
    // Statuses with no sources are present as 0: the client renders four badges and
    // should not be re-deriving the server's enum to fill the gaps.
    expect(res.body.data.sourcesByStatus).toEqual({
      PENDING: 0,
      PROCESSING: 0,
      PROCESSED: 1,
      FAILED: 0,
    });
  });

  it('derives disabled from total minus enabled, so the three cannot disagree', async () => {
    prismaMock.knowledgeChunk.count.mockResolvedValueOnce(4).mockResolvedValueOnce(4);

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks/stats`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.body.data.disabledChunks).toBe(0);
  });

  it('forbids a non-member with a 404', async () => {
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-chunks/stats`)
      .set('Authorization', authHeader(STRANGER_USER));

    expect(res.status).toBe(404);
  });
});

// --------------------------------------------------------------------------------------
// Retrieval testing
// --------------------------------------------------------------------------------------

describe('POST /bots/:botId/knowledge-test', () => {
  const test = (body: unknown, user = OWNER_USER) =>
    request(app)
      .post(`/api/v1/bots/${BOT_ID}/knowledge-test`)
      .set('Authorization', authHeader(user))
      .send(body);

  it('returns the hits with their source filename resolved from Prisma', async () => {
    // The vector row stores `source_id`, not a filename — the two databases do not share
    // a foreign key, so the document name has to be looked up.
    const res = await test({ query: 'refunds' });

    expect(res.status).toBe(200);
    expect(aiMock.searchVectors).toHaveBeenCalledWith({
      bot_id: BOT_ID,
      query: 'refunds',
      top_k: 5,
    });
    expect(res.body.data.results).toEqual([
      {
        chunkId: CHUNK_ID,
        content: 'Refunds take five business days.',
        score: 0.87,
        pageNumber: 3,
        sourceId: SOURCE_ID,
        source: { filename: 'handbook.pdf' },
      },
    ]);
  });

  it('scopes the filename lookup to this bot', async () => {
    await test({ query: 'refunds' });

    expect(prismaMock.knowledgeSource.findMany).toHaveBeenCalledWith({
      where: { id: { in: [SOURCE_ID] }, botId: BOT_ID },
      select: { id: true, filename: true },
    });
  });

  it('reports a null source for a hit whose id is not a document source', async () => {
    // FAQ-derived vectors carry the knowledge entry's id as their `source_id`, and no
    // `knowledge_sources` row matches it. That is a normal result, not a 500.
    aiMock.searchVectors.mockResolvedValue({
      query: 'hours',
      results: [
        { id: CHUNK_ID, content: 'Nine to five.', score: 0.5, metadata: { source_id: 'entry-1' } },
      ],
    });
    prismaMock.knowledgeSource.findMany.mockResolvedValue([]);

    const res = await test({ query: 'hours' });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0]).toMatchObject({ source: null, sourceId: 'entry-1' });
  });

  it('returns an empty result set rather than an error when nothing matches', async () => {
    aiMock.searchVectors.mockResolvedValue({ query: 'nothing', results: [] });

    const res = await test({ query: 'nothing' });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    // No hits means no ids to look up — the query must not be issued with an empty `in`.
    expect(prismaMock.knowledgeSource.findMany).not.toHaveBeenCalled();
  });

  it('defaults topK and honours an explicit one', async () => {
    await test({ query: 'refunds' });
    expect(aiMock.searchVectors).toHaveBeenCalledWith(expect.objectContaining({ top_k: 5 }));

    await test({ query: 'refunds', topK: 12 });
    expect(aiMock.searchVectors).toHaveBeenLastCalledWith(
      expect.objectContaining({ top_k: 12 })
    );
  });

  it('lets an AGENT try retrieval', async () => {
    const res = await test({ query: 'refunds' }, AGENT_USER);

    expect(res.status).toBe(200);
  });

  it('rejects a blank query', async () => {
    const res = await test({ query: '   ' });

    expect(res.status).toBe(400);
    expect(aiMock.searchVectors).not.toHaveBeenCalled();
  });

  it('gives a non-member 404', async () => {
    const res = await test({ query: 'refunds' }, STRANGER_USER);

    expect(res.status).toBe(404);
  });

  it('surfaces the AI failure as a 502 rather than an empty result set', async () => {
    // An empty list would read as "your knowledge base has nothing relevant", which is a
    // different claim from "the search could not run".
    const { AppError } = await import('../src/utils/errors.js');
    aiMock.searchVectors.mockRejectedValue(new AppError('AI service unavailable', 502));

    const res = await test({ query: 'refunds' });

    expect(res.status).toBe(502);
  });
});
