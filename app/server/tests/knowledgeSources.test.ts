/**
 * Tests for knowledge source CRUD, batch document ingestion, and the limits around them
 * (Checkpoints 3–4).
 *
 * The load-bearing claims:
 *
 * 1. **The permission guard runs before multer.** Multer buffers the whole request body
 *    into memory while parsing, so a guard placed after it lets an unauthorized caller
 *    make the server allocate every file before being refused. The test proves ordering by
 *    sending a request multer would itself reject with 400 (too many files) from a caller
 *    who lacks the permission: a 403 can only come from a guard that ran first.
 * 2. **The lifecycle never claims success it did not achieve.** A source reaches
 *    `PROCESSED` only after the vectors are stored *and* the chunk rows are written; any
 *    failure records `FAILED` with a reason instead of leaving the row in `PROCESSING`.
 * 3. **Deleting a source actually deletes the vectors.** Prisma's cascade cannot reach
 *    them — they live in a separate database — so the AI call is the only thing that
 *    removes them, and a failure there must abort the deletion rather than orphan them.
 * 4. **`REJECTED` and `FAILED` are different things.** A rejected file never entered the
 *    pipeline and has no row; a failed file has a row the user can inspect. A batch
 *    containing one bad file is still a 201, because its siblings' work is real.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  // `findUnique` serves the scope resolvers (they only need the workspace id);
  // `findFirst` serves `getBotById`, which checks membership in the same query.
  bot: { findUnique: vi.fn(), findFirst: vi.fn() },
  knowledgeSource: {
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    delete: vi.fn(),
  },
  knowledgeChunk: {
    createMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    // The list route counts each source's enabled chunks with one grouped query, so a
    // missing mock here would surface as a 500 rather than as an empty list.
    groupBy: vi.fn(),
  },
  // The legacy single-file upload re-asserts access through `listKnowledgeByBot`, which
  // reads this model. Absent, the controller throws a TypeError and the route answers 500
  // — which would look like a broken upload rather than a missing mock.
  knowledgeEntry: {
    findMany: vi.fn(),
  },
  platformSetting: {
    upsert: vi.fn(),
    update: vi.fn(),
  },
}));

const aiMock = vi.hoisted(() => ({
  ingestDocument: vi.fn(),
  deleteSourceVectors: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');
const { ingestFile } = await import('../src/services/knowledgeSource.service.js');
const { invalidateSettingsCache, updateSettings } = await import(
  '../src/services/platformSettings.service.js'
);
const { AppError } = await import('../src/utils/errors.js');
const { formatBytes } = await import('../src/utils/format.js');

const OWNER_USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'owner@example.com' };
const AGENT_USER = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'agent@example.com' };
const STRANGER_USER = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', email: 'stranger@example.com' };

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const SOURCE_ID = '33333333-3333-3333-3333-333333333333';
const CHUNK_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_SOURCE_ID = '55555555-5555-5555-5555-555555555555';

const MB = 1024 * 1024;

/**
 * A stand-in for the `UploadLimits` the resolver produces, used by the `ingestFile` unit
 * tests. Deliberately local: production code never reads a default from a constant any
 * more — every route resolves the operator's settings — so a shared fixture in `src/`
 * would be a second copy of the Prisma column defaults waiting to drift from them.
 */
const TEST_LIMITS = {
  maxFileSizeBytes: 10 * MB,
  maxFilesPerRequest: 10,
  maxTotalBytes: 50 * MB,
  maxChunksPerSource: 5000,
};

/** The seeded `platform_settings` row, as the resolver and the settings API see it. */
const settingsRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'singleton',
  maxUploadFileSizeBytes: TEST_LIMITS.maxFileSizeBytes,
  maxUploadFilesPerRequest: TEST_LIMITS.maxFilesPerRequest,
  maxUploadTotalBytes: TEST_LIMITS.maxTotalBytes,
  maxChunksPerSource: TEST_LIMITS.maxChunksPerSource,
  maxChunksPerBot: 0,
  aiServiceMaxFileSizeBytes: 100 * MB,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

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

const sourceRecord = (overrides: Record<string, unknown> = {}) => ({
  id: SOURCE_ID,
  botId: BOT_ID,
  filename: 'handbook.pdf',
  mimeType: 'application/pdf',
  fileSizeBytes: 1024,
  status: 'PENDING',
  pagesExtracted: null,
  chunksCreated: null,
  errorMessage: null,
  topic: null,
  createdAt: new Date(),
  updatedAt: new Date(),
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

const PDF_BYTES = Buffer.from('%PDF-1.4 fake content');

const pdf = (name = 'handbook.pdf') => ({
  buffer: PDF_BYTES,
  originalname: name,
  mimetype: 'application/pdf',
});

/** A multipart request carrying `count` PDFs under the `files` field. */
const uploadRequest = (count: number, user = OWNER_USER) => {
  const req = request(app)
    .post(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload`)
    .set('Authorization', authHeader(user));

  for (let i = 0; i < count; i += 1) {
    req.attach('files', pdf().buffer, {
      filename: `doc-${i}.pdf`,
      contentType: 'application/pdf',
    });
  }
  return req;
};

beforeEach(() => {
  vi.clearAllMocks();
  // The settings cache is module-level state that survives between tests; without this a
  // test that changes a limit would leak it into every test after it.
  invalidateSettingsCache();

  prismaMock.bot.findFirst.mockResolvedValue(botRecord());
  // The scope resolvers read only the owning workspace. Defaulting this to the caller's
  // own workspace means the membership check — not the scope resolution — decides the
  // outcome in most tests, which is what they are meant to be exercising.
  prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });
  prismaMock.knowledgeSource.findUnique.mockResolvedValue({
    bot: { workspaceId: WORKSPACE_ID },
  });
  prismaMock.knowledgeSource.create.mockResolvedValue(sourceRecord());
  prismaMock.knowledgeSource.update.mockImplementation(
    (args: { data?: Record<string, unknown> }) =>
      Promise.resolve(sourceRecord(args?.data ?? {}))
  );
  prismaMock.knowledgeChunk.createMany.mockResolvedValue({ count: 1 });
  prismaMock.knowledgeChunk.count.mockResolvedValue(0);
  // No source has enabled chunks unless a test says so, which is also the case that
  // exercises the `?? 0` fallback: an absent group is a zero, not a missing value.
  prismaMock.knowledgeChunk.groupBy.mockResolvedValue([]);
  prismaMock.knowledgeEntry.findMany.mockResolvedValue([]);
  prismaMock.platformSetting.upsert.mockResolvedValue(settingsRecord());
  setMemberships({ [OWNER_USER.id]: 'OWNER', [AGENT_USER.id]: 'AGENT' });
});

// --------------------------------------------------------------------------------------
// Upload — happy path and lifecycle
// --------------------------------------------------------------------------------------

describe('POST /bots/:botId/knowledge-sources/upload', () => {
  const aiSuccess = {
    success: true,
    bot_id: BOT_ID,
    filename: 'handbook.pdf',
    pages_extracted: 2,
    chunks_created: 1,
    status: 'completed',
    embedding_model: 'all-MiniLM-L6-v2',
    embedding_dimension: 384,
    chunks: [
      {
        id: CHUNK_ID,
        chunk_index: 0,
        content: 'the extracted text',
        page_number: 1,
        topic: 'handbook',
      },
    ],
  };

  it('walks the source through PENDING → PROCESSING → PROCESSED', async () => {
    aiMock.ingestDocument.mockResolvedValue(aiSuccess);

    const res = await uploadRequest(1);

    expect(res.status).toBe(201);
    expect(res.body.data.results[0].outcome).toBe('PROCESSED');
    expect(res.body.data.results[0].chunksCreated).toBe(1);
    expect(res.body.data.results[0].pagesExtracted).toBe(2);
    expect(res.body.data.summary).toEqual({
      total: 1,
      processed: 1,
      failed: 0,
      rejected: 0,
    });

    const statuses = prismaMock.knowledgeSource.update.mock.calls.map(
      (call) => (call[0] as { data: { status: string } }).data.status
    );
    expect(statuses).toEqual(['PROCESSING', 'PROCESSED']);
  });

  it('mirrors every reported chunk into a Prisma row, keyed by the AI service id', async () => {
    // The two databases share no foreign key, so this id is the ONLY join between a chunk
    // row and its vector. A row created with a fresh uuid would be unreachable.
    aiMock.ingestDocument.mockResolvedValue(aiSuccess);

    await uploadRequest(1);

    const rows = prismaMock.knowledgeChunk.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: CHUNK_ID,
      sourceId: SOURCE_ID,
      botId: BOT_ID,
      content: 'the extracted text',
      chunkIndex: 0,
      pageNumber: 1,
      embeddingModel: 'all-MiniLM-L6-v2',
      embeddingDimension: 384,
    });
  });

  it('sends source_id to the AI service so the vectors can be found again', async () => {
    // Without it the vectors are stored with no link to this row, and source deletion
    // becomes impossible — there is nothing to enumerate them by.
    aiMock.ingestDocument.mockResolvedValue(aiSuccess);

    await uploadRequest(1);

    const formData = aiMock.ingestDocument.mock.calls[0][0] as FormData;
    expect(formData.get('source_id')).toBe(SOURCE_ID);
    expect(formData.get('bot_id')).toBe(BOT_ID);
  });

  it('records FAILED with a reason when the AI service fails, and writes no chunk rows', async () => {
    aiMock.ingestDocument.mockRejectedValue(
      new Error('AI service responded with status 400: PDF contains no extractable text')
    );

    const res = await uploadRequest(1);

    // A failed file is still a 201: the request was valid and the batch was processed.
    // Failing the request would discard the work done on any siblings (section 12.7).
    expect(res.status).toBe(201);
    expect(res.body.data.results[0].outcome).toBe('FAILED');
    expect(res.body.data.summary.failed).toBe(1);

    const failCall = prismaMock.knowledgeSource.update.mock.calls.at(-1)?.[0] as {
      data: { status: string; errorMessage: string };
    };
    expect(failCall.data.status).toBe('FAILED');
    expect(failCall.data.errorMessage).toContain('no extractable text');
    expect(prismaMock.knowledgeChunk.createMany).not.toHaveBeenCalled();
  });

  it('does not leave the source stuck in PROCESSING when ingestion throws', async () => {
    aiMock.ingestDocument.mockRejectedValue(new Error('boom'));

    await uploadRequest(1);

    const statuses = prismaMock.knowledgeSource.update.mock.calls.map(
      (call) => (call[0] as { data: { status: string } }).data.status
    );
    expect(statuses.at(-1)).toBe('FAILED');
  });

  it('creates no source row at all for a file it rejects', async () => {
    // REJECTED means the file never entered the pipeline. A `FAILED` row here would
    // clutter the sources list with an entry the user can neither inspect nor act on.
    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload`)
      .set('Authorization', authHeader(OWNER_USER))
      .attach('files', Buffer.from('not a document'), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(400);
    expect(prismaMock.knowledgeSource.create).not.toHaveBeenCalled();
    expect(res.body.data.results[0].outcome).toBe('REJECTED');
  });

  it('returns 400 when no file is supplied', async () => {
    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(400);
  });

  // --- Batch behaviour (section 12.6/12.7) ---

  it('creates one source per file and reports the batch summary', async () => {
    let n = 0;
    prismaMock.knowledgeSource.create.mockImplementation(() =>
      Promise.resolve(sourceRecord({ id: `source-${(n += 1)}` }))
    );
    aiMock.ingestDocument.mockResolvedValue(aiSuccess);

    const res = await uploadRequest(3);

    expect(res.status).toBe(201);
    expect(res.body.data.summary).toEqual({ total: 3, processed: 3, failed: 0, rejected: 0 });
    expect(prismaMock.knowledgeSource.create).toHaveBeenCalledTimes(3);
    expect(aiMock.ingestDocument).toHaveBeenCalledTimes(3);
  });

  it('records the true byte length of every file it parses', async () => {
    // Pins the parser against a regression no outcome-based assertion can see: multer's
    // `fileSize` was once computed as `Math.min(undefined, …)`, and a NaN limit makes
    // busboy truncate every file to zero bytes. Statuses, summaries and row counts all
    // stayed green through that — only the recorded size gives it away.
    let n = 0;
    prismaMock.knowledgeSource.create.mockImplementation(() =>
      Promise.resolve(sourceRecord({ id: `source-${(n += 1)}` }))
    );
    aiMock.ingestDocument.mockResolvedValue(aiSuccess);

    const res = await uploadRequest(2);

    expect(res.status).toBe(201);
    const recorded = prismaMock.knowledgeSource.create.mock.calls.map(
      (call) => (call[0] as { data: { fileSizeBytes: number } }).data.fileSizeBytes
    );
    expect(recorded).toEqual([PDF_BYTES.length, PDF_BYTES.length]);
  });

  it('keeps a mixed batch at 201 with per-file outcomes, and no row for the rejected file', async () => {
    // The whole point of per-file outcomes: one unreadable file must not fail the other
    // nine, and must not surface as an error toast for the whole upload.
    aiMock.ingestDocument.mockResolvedValue(aiSuccess);

    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload`)
      .set('Authorization', authHeader(OWNER_USER))
      .attach('files', pdf().buffer, { filename: 'a.pdf', contentType: 'application/pdf' })
      .attach('files', Buffer.from('nope'), { filename: 'b.png', contentType: 'image/png' })
      .attach('files', pdf().buffer, { filename: 'c.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.data.summary).toEqual({ total: 3, processed: 2, failed: 0, rejected: 1 });

    const rejected = res.body.data.results.find(
      (r: { outcome: string }) => r.outcome === 'REJECTED'
    );
    expect(rejected.filename).toBe('b.png');
    expect(rejected.sourceId).toBeUndefined();
    // Two accepted files, so exactly two rows — the rejected one never got one.
    expect(prismaMock.knowledgeSource.create).toHaveBeenCalledTimes(2);
  });

  it('preserves the order the client sent, even though files finish out of order', async () => {
    // Results are placed by index, not by completion: the first file is made the slowest
    // so a completion-ordered implementation would return it last.
    const order: string[] = [];
    prismaMock.knowledgeSource.create.mockImplementation(
      (args: { data: { filename: string } }) => {
        order.push(args.data.filename);
        // doc-0 waits on doc-1 and doc-2, which are faster.
        const delay = args.data.filename === 'doc-0.pdf' ? 30 : 1;
        return new Promise((resolve) =>
          setTimeout(() => resolve(sourceRecord({ filename: args.data.filename })), delay)
        );
      }
    );
    aiMock.ingestDocument.mockResolvedValue(aiSuccess);

    const res = await uploadRequest(3);

    expect(res.status).toBe(201);
    expect(res.body.data.results.map((r: { filename: string }) => r.filename)).toEqual([
      'doc-0.pdf',
      'doc-1.pdf',
      'doc-2.pdf',
    ]);
  });

  it('processes no more than three files at once', async () => {
    // Unbounded fan-out would push every embedding call at the provider at once and
    // simply queue inside the single-process AI service (section 12.8).
    let inFlight = 0;
    let peak = 0;
    aiMock.ingestDocument.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return aiSuccess;
    });

    await uploadRequest(7);

    expect(peak).toBe(3);
  });

  it('runs the AI call with the batch timeout, not the single-file one', async () => {
    // A batch holds the request open through ceil(N/3) sequential ingestion calls, so the
    // shorter single-file allowance would abort work the server is still doing.
    aiMock.ingestDocument.mockResolvedValue(aiSuccess);

    await uploadRequest(1);

    expect(aiMock.ingestDocument).toHaveBeenCalledWith(expect.any(FormData), true);
  });

  // --- Request-level limits (section 12.5/12.11) ---

  it('rejects a batch larger than the configured file count, processing nothing', async () => {
    prismaMock.platformSetting.upsert.mockResolvedValue(
      settingsRecord({ maxUploadFilesPerRequest: 3 })
    );

    const res = await uploadRequest(4);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('3');
    expect(prismaMock.knowledgeSource.create).not.toHaveBeenCalled();
    expect(aiMock.ingestDocument).not.toHaveBeenCalled();
  });

  it('applies a changed limit to the very next request, with the parser rebuilt each time', async () => {
    // The strongest form of "takes effect without a restart": two uploads in one process,
    // with the setting changed in between. A module-level multer (built once, at import)
    // would parse both at the original cap and pass every single-request test above.
    aiMock.ingestDocument.mockResolvedValue(aiSuccess);

    const first = await uploadRequest(3);
    expect(first.status).toBe(201);

    // Changed through the real write path, which invalidates the settings cache — the
    // sequence a platform owner's PATCH produces. Writing the row behind the cache's back
    // would leave the next request reading the cached value for up to the TTL, which is
    // the documented behaviour, not a bug.
    prismaMock.platformSetting.upsert.mockResolvedValue(
      settingsRecord({ maxUploadFilesPerRequest: 2 })
    );
    await updateSettings({ maxUploadFilesPerRequest: 2 });

    const second = await uploadRequest(3);
    expect(second.status).toBe(400);
    expect(second.body.error).toContain('2');
    // Still exactly the three from the first request — the refused batch wrote nothing.
    expect(prismaMock.knowledgeSource.create).toHaveBeenCalledTimes(3);
  });

  it('rejects a batch whose files are individually valid but jointly over the combined limit', async () => {
    // `limits.files` counts files, not bytes: ten files under the per-file ceiling can
    // still be several times the combined limit, which is this request's heap ceiling.
    prismaMock.platformSetting.upsert.mockResolvedValue(
      settingsRecord({ maxUploadTotalBytes: 2 * MB })
    );

    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload`)
      .set('Authorization', authHeader(OWNER_USER))
      .attach('files', Buffer.alloc(1.5 * MB, 1), {
        filename: 'a.pdf',
        contentType: 'application/pdf',
      })
      .attach('files', Buffer.alloc(1.5 * MB, 1), {
        filename: 'b.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(formatBytes(2 * MB));
    expect(prismaMock.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it('rejects an upload when the bot is already at its chunk quota', async () => {
    prismaMock.platformSetting.upsert.mockResolvedValue(
      settingsRecord({ maxChunksPerBot: 100 })
    );
    prismaMock.knowledgeChunk.count.mockResolvedValue(100);

    const res = await uploadRequest(1);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('capacity');
    expect(prismaMock.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it('treats a zero chunk quota as unlimited, not as "no chunks allowed"', async () => {
    prismaMock.platformSetting.upsert.mockResolvedValue(settingsRecord({ maxChunksPerBot: 0 }));
    prismaMock.knowledgeChunk.count.mockResolvedValue(999_999);
    aiMock.ingestDocument.mockResolvedValue(aiSuccess);

    const res = await uploadRequest(1);

    expect(res.status).toBe(201);
  });

  it('rejects a file over the configured per-file limit without failing its siblings', async () => {
    prismaMock.platformSetting.upsert.mockResolvedValue(
      settingsRecord({ maxUploadFileSizeBytes: 1 * MB })
    );
    aiMock.ingestDocument.mockResolvedValue(aiSuccess);

    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload`)
      .set('Authorization', authHeader(OWNER_USER))
      .attach('files', Buffer.alloc(2 * MB, 1), {
        filename: 'big.pdf',
        contentType: 'application/pdf',
      })
      .attach('files', pdf().buffer, { filename: 'small.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.data.summary).toEqual({ total: 2, processed: 1, failed: 0, rejected: 1 });
    const rejected = res.body.data.results.find(
      (r: { outcome: string }) => r.outcome === 'REJECTED'
    );
    expect(rejected.error).toContain('1 MB');
  });

  it('reports an all-rejected batch as a 400 carrying the per-file reasons', async () => {
    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload`)
      .set('Authorization', authHeader(OWNER_USER))
      .attach('files', Buffer.from('nope'), { filename: 'a.png', contentType: 'image/png' })
      .attach('files', Buffer.from('nope'), { filename: 'b.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    // The client parses one shape for both the 201 and this 400.
    expect(res.body.data.summary.rejected).toBe(2);
    expect(res.body.data.results.map((r: { filename: string }) => r.filename)).toEqual([
      'a.png',
      'b.txt',
    ]);
    expect(prismaMock.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it('enforces the limits even when the client skips its pre-flight checks', async () => {
    // The client is never authoritative (section 12.5) — this request is what a crafted
    // one looks like, bypassing every UI check.
    prismaMock.platformSetting.upsert.mockResolvedValue(
      settingsRecord({ maxUploadFilesPerRequest: 1 })
    );

    const res = await uploadRequest(2);

    expect(res.status).toBe(400);
  });
});

// --------------------------------------------------------------------------------------
// Legacy single-file upload
// --------------------------------------------------------------------------------------

describe('POST /bots/:botId/knowledge/upload-document', () => {
  const legacyUpload = (body: Buffer, filename = 'handbook.pdf') =>
    request(app)
      .post(`/api/v1/bots/${BOT_ID}/knowledge/upload-document`)
      .set('Authorization', authHeader(OWNER_USER))
      // The content type follows the filename, so the wrong-type case below actually
      // presents a type the route's filter rejects rather than being let through by a
      // hardcoded `application/pdf`.
      .attach('file', body, {
        filename,
        contentType: filename.endsWith('.pdf') ? 'application/pdf' : 'text/plain',
      });

  it('refuses a file over the configured limit with a 413 quoting that limit', async () => {
    // The route used to carry a 10 MB literal. It now builds its parser from the
    // operator's resolved settings (section 12.11), so the number in the message has to be
    // the one that was actually applied — a stale "10 MB" would send the user off to
    // shrink a file the platform would already have accepted.
    prismaMock.platformSetting.upsert.mockResolvedValue(
      settingsRecord({ maxUploadFileSizeBytes: 2 * MB })
    );

    const res = await legacyUpload(Buffer.alloc(3 * MB, 1));

    // 413 Payload Too Large, not the 400 the plan's case table sketches: the request was
    // well-formed and the caller is authorized — the body was simply bigger than this
    // platform accepts, which is what 413 means. This is a single-file route, so refusing
    // the whole request is also the right granularity; the batch route rejects per file.
    expect(res.status).toBe(413);
    expect(res.body.error).toContain('2 MB');
    expect(res.body.error).not.toContain('10 MB');
    expect(prismaMock.knowledgeSource.create).not.toHaveBeenCalled();
    expect(aiMock.ingestDocument).not.toHaveBeenCalled();
  });

  it('accepts a file within the configured limit', async () => {
    // The complement, so the 413 above cannot pass by rejecting everything: a file under
    // the resolved ceiling still reaches the handler and is forwarded to the AI service.
    //
    // Note what this route does *not* do: it writes no `knowledge_sources` row. It is the
    // pre-Checkpoint-3 contract, kept working for existing clients, so its document is
    // never listed in the dashboard and never counted against the chunk quota — only the
    // batch route creates the mirror rows.
    prismaMock.platformSetting.upsert.mockResolvedValue(
      settingsRecord({ maxUploadFileSizeBytes: 2 * MB })
    );
    aiMock.ingestDocument.mockResolvedValue({
      success: true,
      source_id: SOURCE_ID,
      chunks_created: 4,
      pages_extracted: 2,
      chunks: [],
    });

    const res = await legacyUpload(pdf().buffer);

    expect(res.status).toBe(201);
    expect(aiMock.ingestDocument).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it('refuses a file type the operator does not accept, before the body is handled', async () => {
    const res = await legacyUpload(Buffer.from('plain text'), 'notes.txt');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('PDF');
  });
});

// --------------------------------------------------------------------------------------
// Resolved limits endpoint
// --------------------------------------------------------------------------------------

describe('GET /bots/:botId/knowledge-sources/upload-limits', () => {
  it('returns the resolved limits for the client pre-flight', async () => {
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload-limits`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      maxFileSizeBytes: TEST_LIMITS.maxFileSizeBytes,
      maxFilesPerRequest: TEST_LIMITS.maxFilesPerRequest,
      maxTotalBytes: TEST_LIMITS.maxTotalBytes,
      maxChunksPerSource: TEST_LIMITS.maxChunksPerSource,
      maxChunksPerBot: 0,
      acceptedExtensions: ['.pdf', '.docx'],
    });
  });

  it('does not expose the AI service backstop to a workspace member', async () => {
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload-limits`)
      .set('Authorization', authHeader(OWNER_USER));

    // `aiServiceMaxFileSizeBytes` is an internal safety ceiling, not a limit this tier
    // advertises. It stays on `PlatformSetting`, where only the platform owner reads it.
    expect(res.body.data).not.toHaveProperty('aiServiceMaxFileSizeBytes');
  });

  it('reflects a settings change immediately, without a restart', async () => {
    prismaMock.platformSetting.upsert.mockResolvedValue(
      settingsRecord({ maxUploadFilesPerRequest: 7 })
    );

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload-limits`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.body.data.maxFilesPerRequest).toBe(7);
  });

  it('is readable by an AGENT, who is the caller that renders the upload UI', async () => {
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload-limits`)
      .set('Authorization', authHeader(AGENT_USER));

    expect(res.status).toBe(200);
  });

  it('404s for a non-member rather than confirming the bot exists', async () => {
    setMemberships({});

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-sources/upload-limits`)
      .set('Authorization', authHeader(STRANGER_USER));

    expect(res.status).toBe(404);
  });
});

// --------------------------------------------------------------------------------------
// Authorization
// --------------------------------------------------------------------------------------

describe('upload authorization', () => {
  it('the permission guard runs BEFORE multer buffers the body', async () => {
    // The request carries MORE files than the limit, so multer would abort it with 400
    // ("Maximum 10 files per upload"). Getting a 403 instead proves the guard ran first.
    //
    // The count is what makes this test discriminating: the batch parser accepts every
    // content type (a per-file rejection cannot be attributed inside a fileFilter), so a
    // wrong-type file would no longer distinguish the two orderings — it would be buffered
    // either way. Exceeding a multer limit is decided by multer alone.
    const res = await uploadRequest(11, AGENT_USER);

    expect(res.status).toBe(403);
    expect(prismaMock.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it('an AGENT cannot delete a source', async () => {
    const res = await request(app)
      .delete(`/api/v1/knowledge-sources/${SOURCE_ID}`)
      .set('Authorization', authHeader(AGENT_USER));

    expect(res.status).toBe(403);
    expect(aiMock.deleteSourceVectors).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeSource.delete).not.toHaveBeenCalled();
  });

  it('an AGENT can read the source list', async () => {
    prismaMock.knowledgeSource.findMany.mockResolvedValue([]);
    prismaMock.knowledgeSource.count.mockResolvedValue(0);

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-sources`)
      .set('Authorization', authHeader(AGENT_USER));

    expect(res.status).toBe(200);
  });

  it('a non-member gets 404 on upload, never 403', async () => {
    // 403 would confirm the bot exists. A tenant the caller cannot see must be
    // indistinguishable from one that does not exist.
    setMemberships({});

    const res = await uploadRequest(1, STRANGER_USER);

    expect(res.status).toBe(404);
  });

  it('a source in another workspace is a 404, not a 403', async () => {
    setMemberships({ [OWNER_USER.id]: 'OWNER' });
    // The scope resolver finds the source, but the caller has no membership in its
    // workspace — so the middleware reports "workspace not found".
    prismaMock.knowledgeSource.findUnique.mockResolvedValue({
      bot: { workspaceId: '99999999-9999-9999-9999-999999999999' },
    });

    const res = await request(app)
      .get(`/api/v1/knowledge-sources/${SOURCE_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(404);
  });

  it('unauthenticated requests are rejected', async () => {
    const res = await request(app).get(`/api/v1/bots/${BOT_ID}/knowledge-sources`);
    expect(res.status).toBe(401);
  });
});

// --------------------------------------------------------------------------------------
// List and detail
// --------------------------------------------------------------------------------------

describe('GET /bots/:botId/knowledge-sources', () => {
  it('returns the page alongside the pagination block', async () => {
    prismaMock.knowledgeSource.findMany.mockResolvedValue([sourceRecord({ status: 'PROCESSED' })]);
    prismaMock.knowledgeSource.count.mockResolvedValue(45);

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-sources?page=2&limit=20`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(res.body.data.pagination).toEqual({ page: 2, limit: 20, total: 45, totalPages: 3 });
    expect(prismaMock.knowledgeSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20 })
    );
  });

  it('annotates each source with its enabled chunk count and total chunk count', async () => {
    // The Sources table shows "22 / 24 chunks". The total comes from `_count` on the row;
    // the enabled part comes from one grouped query for the whole page, so this pins that
    // the two are merged back onto the right sources rather than summed across them.
    prismaMock.knowledgeSource.findMany.mockResolvedValue([
      sourceRecord({ id: SOURCE_ID, _count: { chunks: 24 } }),
      sourceRecord({ id: OTHER_SOURCE_ID, _count: { chunks: 7 } }),
    ]);
    prismaMock.knowledgeSource.count.mockResolvedValue(2);
    prismaMock.knowledgeChunk.groupBy.mockResolvedValue([
      { sourceId: SOURCE_ID, _count: { _all: 22 } },
    ]);

    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-sources`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(res.body.data.sources).toEqual([
      expect.objectContaining({ id: SOURCE_ID, enabledChunks: 22 }),
      // No group for this source means zero enabled chunks, not a missing field — the
      // difference between "all disabled" and "nothing rendered" is the whole point of
      // showing the number.
      expect.objectContaining({ id: OTHER_SOURCE_ID, enabledChunks: 0 }),
    ]);

    // Scoped to the bot: a group for another bot's chunks must not be able to inflate a
    // count here, so the query carries the same tenant filter the list does.
    expect(prismaMock.knowledgeChunk.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['sourceId'],
        where: { botId: BOT_ID, enabled: true },
      })
    );
  });

  it('passes the status filter through to the query', async () => {
    prismaMock.knowledgeSource.findMany.mockResolvedValue([]);
    prismaMock.knowledgeSource.count.mockResolvedValue(0);

    await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-sources?status=FAILED`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(prismaMock.knowledgeSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { botId: BOT_ID, status: 'FAILED' } })
    );
  });

  it('rejects an unknown status with 400 rather than ignoring it', async () => {
    // Silently dropping an unrecognized filter would return the unfiltered list while the
    // UI claims it is filtered.
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-sources?status=REJECTED`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(400);
  });

  it('caps the page size at 100', async () => {
    const res = await request(app)
      .get(`/api/v1/bots/${BOT_ID}/knowledge-sources?limit=5000`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(400);
  });
});

describe('GET /knowledge-sources/:sourceId', () => {
  it('returns the enabled and disabled chunk counts', async () => {
    prismaMock.knowledgeSource.findFirst.mockResolvedValue({
      ...sourceRecord({ status: 'PROCESSED' }),
      _count: { chunks: 12 },
    });
    prismaMock.knowledgeChunk.count
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(3);

    const res = await request(app)
      .get(`/api/v1/knowledge-sources/${SOURCE_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(res.body.data.enabledChunks).toBe(9);
    expect(res.body.data.disabledChunks).toBe(3);
  });

  it('rejects a malformed id before touching the database', async () => {
    const res = await request(app)
      .get('/api/v1/knowledge-sources/not-a-uuid')
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(400);
    expect(prismaMock.knowledgeSource.findFirst).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------------------
// Delete
// --------------------------------------------------------------------------------------

describe('DELETE /knowledge-sources/:sourceId', () => {
  const processedSource = () => ({
    ...sourceRecord({ status: 'PROCESSED' }),
    _count: { chunks: 12 },
  });

  beforeEach(() => {
    prismaMock.knowledgeSource.findFirst.mockResolvedValue(processedSource());
    prismaMock.knowledgeChunk.count.mockResolvedValue(0);
    prismaMock.knowledgeSource.delete.mockResolvedValue(sourceRecord());
    aiMock.deleteSourceVectors.mockResolvedValue({ success: true, chunks_deleted: 12 });
  });

  it('deletes the vectors and then the row, reporting the chunk count', async () => {
    const res = await request(app)
      .delete(`/api/v1/knowledge-sources/${SOURCE_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('12 chunks');
    expect(aiMock.deleteSourceVectors).toHaveBeenCalledWith(BOT_ID, SOURCE_ID);
    expect(prismaMock.knowledgeSource.delete).toHaveBeenCalledWith({ where: { id: SOURCE_ID } });
  });

  it('deletes the vectors BEFORE the row', async () => {
    // The reverse order would delete the row first, and a failed vector deletion would
    // leave vectors that nothing can enumerate — unreachable, undeletable, and still
    // retrievable.
    const order: string[] = [];
    aiMock.deleteSourceVectors.mockImplementation(() => {
      order.push('vectors');
      return Promise.resolve({ chunks_deleted: 12 });
    });
    prismaMock.knowledgeSource.delete.mockImplementation(() => {
      order.push('row');
      return Promise.resolve(sourceRecord());
    });

    await request(app)
      .delete(`/api/v1/knowledge-sources/${SOURCE_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(order).toEqual(['vectors', 'row']);
  });

  it('leaves the row intact when vector deletion fails', async () => {
    // The real client wraps every transport failure in a 502 AppError; mirroring that
    // here is what makes the status assertion below meaningful.
    aiMock.deleteSourceVectors.mockRejectedValue(
      new AppError('The AI service is currently unavailable. Please try again later.', 502)
    );

    const res = await request(app)
      .delete(`/api/v1/knowledge-sources/${SOURCE_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(502);
    expect(prismaMock.knowledgeSource.delete).not.toHaveBeenCalled();
  });

  it('refuses to delete a source that is still processing', async () => {
    // Deleting now would race the in-flight ingestion, which would go on to write chunks
    // and vectors for a source that no longer exists.
    prismaMock.knowledgeSource.findFirst.mockResolvedValue({
      ...sourceRecord({ status: 'PROCESSING' }),
      _count: { chunks: 0 },
    });

    const res = await request(app)
      .delete(`/api/v1/knowledge-sources/${SOURCE_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(409);
    expect(aiMock.deleteSourceVectors).not.toHaveBeenCalled();
    expect(prismaMock.knowledgeSource.delete).not.toHaveBeenCalled();
  });

  it('404s for a source the caller cannot see', async () => {
    prismaMock.knowledgeSource.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/v1/knowledge-sources/${SOURCE_ID}`)
      .set('Authorization', authHeader(OWNER_USER));

    expect(res.status).toBe(404);
  });
});

// --------------------------------------------------------------------------------------
// Service-level ingestion: the seam Checkpoint 4 wraps in a per-file loop
// --------------------------------------------------------------------------------------

describe('ingestFile', () => {
  it('returns a per-file outcome instead of throwing on an AI failure', async () => {
    // This is what makes batch upload possible: one file's failure is a result value, not
    // an exception that would abort its siblings.
    aiMock.ingestDocument.mockRejectedValue(new Error('extraction failed'));

    const result = await ingestFile(BOT_ID, pdf(), undefined, TEST_LIMITS);

    expect(result.outcome).toBe('FAILED');
    expect(result.error).toContain('extraction failed');
    expect(result.sourceId).toBe(SOURCE_ID);
  });

  it('rejects an oversize file without creating a row', async () => {
    const result = await ingestFile(
      BOT_ID,
      { ...pdf(), size: 20 * 1024 * 1024 },
      undefined,
      TEST_LIMITS
    );

    expect(result.outcome).toBe('REJECTED');
    expect(result.error).toContain('10 MB');
    expect(prismaMock.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it('quotes the resolved limit, not a hardcoded one, in the rejection', async () => {
    // Section 12.11: a message naming 10 MB contradicts the configuration the moment an
    // operator changes it.
    const result = await ingestFile(
      BOT_ID,
      { ...pdf(), size: 5 * 1024 * 1024 },
      undefined,
      { ...TEST_LIMITS, maxFileSizeBytes: 2 * 1024 * 1024 }
    );

    expect(result.outcome).toBe('REJECTED');
    expect(result.error).toContain('2 MB');
    expect(result.error).not.toContain('10 MB');
  });

  it('rejects a file whose extension and MIME type disagree', async () => {
    const result = await ingestFile(
      BOT_ID,
      { ...pdf(), originalname: 'notes.txt' },
      undefined,
      TEST_LIMITS
    );

    expect(result.outcome).toBe('REJECTED');
    expect(prismaMock.knowledgeSource.create).not.toHaveBeenCalled();
  });

  it('fails the source when the document exceeds the chunk quota', async () => {
    // Checked before any chunk row is written, so the overflow leaves no partial set.
    aiMock.ingestDocument.mockResolvedValue({
      success: true,
      pages_extracted: 1,
      chunks_created: 3,
      embedding_model: 'm',
      embedding_dimension: 384,
      chunks: [0, 1, 2].map((i) => ({
        id: `chunk-${i}`,
        chunk_index: i,
        content: 'x',
        page_number: null,
        topic: null,
      })),
    });

    const result = await ingestFile(
      BOT_ID,
      pdf(),
      undefined,
      { ...TEST_LIMITS, maxChunksPerSource: 2 }
    );

    expect(result.outcome).toBe('FAILED');
    expect(result.error).toContain('above the 2 limit');
    expect(prismaMock.knowledgeChunk.createMany).not.toHaveBeenCalled();
  });

  it('records the AI service’s own explanation, not the generic outage text', async () => {
    // A malformed PDF is answered with a 400 and the extraction error (section 18.2). The
    // generic 502 text — which the AI client uses for every other failure — would tell the
    // user to check on a service that is running fine, when the thing to fix is their file.
    const { AIServiceError } = await import('../src/utils/errors.js');
    aiMock.ingestDocument.mockRejectedValue(
      new AIServiceError('Failed to process PDF file: cannot read stream', {
        status: 400,
        detail: 'Failed to process PDF file: cannot read stream',
      })
    );

    const result = await ingestFile(BOT_ID, pdf(), undefined, TEST_LIMITS);

    expect(result.outcome).toBe('FAILED');
    expect(result.error).toBe('Failed to process PDF file: cannot read stream');
    // The row records the same reason the user was shown, so the two cannot disagree.
    expect(prismaMock.knowledgeSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorMessage: 'Failed to process PDF file: cannot read stream' }),
      })
    );
  });

  it('keeps the generic message when the AI service itself is down', async () => {
    // The other half of the same rule: a 5xx explains nothing the customer can act on, so
    // its internals must not be forwarded into a user-facing field.
    const { AIServiceError } = await import('../src/utils/errors.js');
    aiMock.ingestDocument.mockRejectedValue(
      new AIServiceError('The AI service is currently unavailable. Please try again later.', {
        status: 500,
        detail: 'psycopg.OperationalError: connection refused at 10.0.0.4',
      })
    );

    const result = await ingestFile(BOT_ID, pdf(), undefined, TEST_LIMITS);

    expect(result.outcome).toBe('FAILED');
    expect(result.error).toBe('The AI service is currently unavailable. Please try again later.');
    expect(result.error).not.toContain('10.0.0.4');
  });
});
