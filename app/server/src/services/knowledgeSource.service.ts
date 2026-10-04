import type { KnowledgeSource, Prisma } from '@prisma/client';
import prisma from '../config/database.js';
import { AppError, AIServiceError, ConflictError, NotFoundError } from '../utils/errors.js';
import { getBotById } from './bot.service.js';
import { aiServiceClient } from './aiServiceClient.js';
import { logger } from '../config/logger.js';
import { ACCEPTED_EXTENSIONS, ACCEPTED_MIME_TYPES, ACCEPTED_TYPES_LABEL } from '../constants/uploads.js';
import { formatBytes } from '../utils/format.js';
import type {
  EffectiveUploadLimits,
  UploadLimits,
  UploadResultItem,
  UploadSummary,
} from '../types/knowledge.types.js';
import { summarizeUploads } from '../types/knowledge.types.js';
import type { ListSourcesQuery } from '../schemas/knowledgeSource.schema.js';
import path from 'node:path';

/** The subset of a multer file this service needs. */
export interface UploadedFileLike {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

/** A source plus the chunk counts the detail view renders. */
export interface SourceWithCounts extends KnowledgeSource {
  _count: { chunks: number };
  enabledChunks: number;
  disabledChunks: number;
}

/**
 * Validate one file against the resolved limits.
 *
 * Returns a human-readable reason, or null when the file is acceptable. This is the
 * single place a file's acceptability is decided. Multer's `fileFilter` is a second,
 * earlier gate on the single-file route, but it cannot serve the batch route: it aborts
 * the whole request, and section 12.6 requires one bad file to become a per-file
 * `REJECTED` while its siblings are still processed.
 */
export const validateFile = (file: UploadedFileLike, limits: UploadLimits): string | null => {
  const extension = path.extname(file.originalname).toLowerCase();

  // Both checks are required. The extension is what the Python extractor dispatches on,
  // and the MIME type is what the browser claimed; requiring them to agree costs nothing
  // and rejects a file that only pretends to be a PDF.
  if (!ACCEPTED_EXTENSIONS.includes(extension) || !ACCEPTED_MIME_TYPES.includes(file.mimetype)) {
    return `Only ${ACCEPTED_TYPES_LABEL} files are allowed.`;
  }

  if (file.size > limits.maxFileSizeBytes) {
    return `File exceeds the ${formatBytes(limits.maxFileSizeBytes)} limit.`;
  }

  return null;
};

/**
 * Ingest one uploaded document: extract → chunk → embed → store, mirrored into Prisma.
 *
 * Returns a per-file outcome instead of throwing for expected failures. A file that fails
 * is not an exception at this layer — under batch upload it is a normal result alongside
 * its successful siblings, and section 12.7 requires a mixed response to be a 201. Only
 * genuinely unexpected faults (a programming error) propagate.
 *
 * Lifecycle: the source is created `PENDING`, moved to `PROCESSING` before the AI call,
 * and only reaches `PROCESSED` once the vectors are stored *and* the chunk rows are
 * written. Any failure along the way records `FAILED` with the reason, so the row always
 * tells the user what happened — a source left silently in `PROCESSING` would look like
 * it is still working.
 */
export const ingestFile = async (
  botId: string,
  file: UploadedFileLike,
  topic: string | undefined,
  limits: UploadLimits,
  options: { batchTimeout?: boolean } = {}
): Promise<UploadResultItem> => {
  const rejection = validateFile(file, limits);
  if (rejection) {
    // No row: the file never entered the pipeline, so there is nothing to inspect or
    // delete afterwards (section 12.6).
    return { filename: file.originalname, outcome: 'REJECTED', error: rejection };
  }

  const source = await prisma.knowledgeSource.create({
    data: {
      botId,
      filename: file.originalname,
      mimeType: file.mimetype,
      fileSizeBytes: file.size,
      topic: topic ?? null,
      status: 'PENDING',
    },
  });

  await prisma.knowledgeSource.update({
    where: { id: source.id },
    data: { status: 'PROCESSING' },
  });

  try {
    const formData = new FormData();
    formData.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
    formData.append('bot_id', botId);
    // The AI service stores this as each vector's `source_id` — the only link back to
    // this row, and therefore the key that makes source deletion possible.
    formData.append('source_id', source.id);
    if (topic) {
      formData.append('topic', topic);
    }

    const result = await aiServiceClient.ingestDocument(formData, options.batchTimeout ?? false);

    if (!result.success) {
      throw new Error(result.error ?? 'Document ingestion failed');
    }

    const chunks = result.chunks ?? [];

    if (chunks.length > limits.maxChunksPerSource) {
      // The AI service already refuses to chunk past its own absolute ceiling; this
      // catches the case where the operator's configured limit is the stricter one.
      // Checked before writing, so the overflow leaves no partial chunk set behind.
      throw new Error(
        `Document produced ${chunks.length} chunks, above the ${limits.maxChunksPerSource} limit.`
      );
    }

    // Rows are keyed by the AI service's chunk ids. The two databases share no foreign
    // key, so this id is the only join between a chunk row and its vector.
    await prisma.knowledgeChunk.createMany({
      data: chunks.map((chunk) => ({
        id: chunk.id,
        sourceId: source.id,
        botId,
        content: chunk.content,
        chunkIndex: chunk.chunk_index,
        pageNumber: chunk.page_number,
        topic: chunk.topic ?? topic ?? null,
        embeddingModel: result.embedding_model,
        embeddingDimension: result.embedding_dimension,
        lastEmbeddedAt: new Date(),
      })),
    });

    await prisma.knowledgeSource.update({
      where: { id: source.id },
      data: {
        status: 'PROCESSED',
        pagesExtracted: result.pages_extracted,
        chunksCreated: chunks.length,
        errorMessage: null,
      },
    });

    logger.info(
      { botId, sourceId: source.id, chunks: chunks.length },
      'Document source ingested'
    );

    return {
      filename: file.originalname,
      outcome: 'PROCESSED',
      sourceId: source.id,
      chunksCreated: chunks.length,
      pagesExtracted: result.pages_extracted,
    };
  } catch (err) {
    // `reason`, not `message`, when the AI service explained itself. A malformed PDF is
    // answered by the AI service with a 400 and the extraction error; the generic 502 text
    // ("The AI service is currently unavailable") would tell the user to check on a service
    // that is running fine, when the thing to fix is their file (section 18.2).
    const message =
      err instanceof AIServiceError
        ? err.reason
        : err instanceof Error
          ? err.message
          : String(err);

    logger.error({ err, botId, sourceId: source.id }, 'Document source ingestion failed');

    // Recording the failure must not itself throw — that would replace the real reason
    // with a database error and lose the outcome the user needs to see.
    try {
      await prisma.knowledgeSource.update({
        where: { id: source.id },
        data: { status: 'FAILED', errorMessage: message },
      });
    } catch (updateErr) {
      logger.error(
        { err: updateErr, sourceId: source.id },
        'Failed to record ingestion failure on the source row'
      );
    }

    // Any vectors already stored by the AI service are deliberately left in place. They
    // are unreachable — nothing is `PROCESSED`, so nothing lists their chunks — and a
    // later retry overwrites them. Deleting them here would need a second network call
    // inside the failure path, which is exactly where it is most likely to fail too.
    return {
      filename: file.originalname,
      outcome: 'FAILED',
      sourceId: source.id,
      error: message,
    };
  }
};

/**
 * How many files of one batch are ingested at once (section 12.8).
 *
 * Bounded rather than unbounded because each file is an embedding call to the provider:
 * fanning out ten at once invites rate limits and simply queues inside the AI service,
 * which is a single process. Three keeps the pipeline busy without stampeding it.
 */
export const BATCH_CONCURRENCY = 3;

/** The per-file results of a batch, plus their aggregate counts. */
export interface BatchIngestResult {
  results: UploadResultItem[];
  summary: UploadSummary;
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order.
 *
 * A worker pool rather than `Promise.all` over chunks: chunking would make every worker
 * wait for the slowest file in its chunk, so a single slow document would stall three
 * slots instead of one. Results are placed by index, so the response order matches the
 * order the client sent the files regardless of completion order.
 */
const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
};

/**
 * Ingest a batch of uploaded documents, one file at a time within a bounded pool.
 *
 * Request-level violations throw (400) **before** any file is processed, so a request
 * that breaks a rule leaves nothing behind — not even a `FAILED` row. Per-file problems
 * do not throw; they come back as `REJECTED`/`FAILED` entries alongside their successful
 * siblings (section 12.7). Deciding which of those makes the HTTP response a 400 is the
 * controller's job, because only it knows whether anything succeeded.
 *
 * One AI call per file, not one bulk call: that keeps the AI contract unchanged, gives
 * per-file status and error messages for free, and stops one crash or timeout from taking
 * the whole batch with it.
 */
export const ingestBatch = async (
  botId: string,
  files: UploadedFileLike[],
  topic: string | undefined,
  limits: EffectiveUploadLimits
): Promise<BatchIngestResult> => {
  if (files.length === 0) {
    throw new AppError('At least one file is required', 400);
  }

  // `limits.files` in multer already aborts a request with too many files, but a service
  // that relies on its parser having done so is only safe while every caller comes through
  // that parser. Re-checking here costs nothing and makes the rule a property of ingestion.
  if (files.length > limits.maxFilesPerRequest) {
    throw new AppError(`Maximum ${limits.maxFilesPerRequest} files per upload`, 400);
  }

  // `limits.files` counts files, not bytes: ten files under the per-file ceiling can still
  // be several times the combined limit, which is the ceiling on this request's heap.
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > limits.maxTotalBytes) {
    throw new AppError(
      `Combined upload size exceeds the ${formatBytes(limits.maxTotalBytes)} limit`,
      400
    );
  }

  if (limits.maxChunksPerBot > 0) {
    const existing = await prisma.knowledgeChunk.count({ where: { botId } });
    if (existing >= limits.maxChunksPerBot) {
      // Checked before any file is touched. A quota that only fails mid-batch would leave
      // sources half-ingested with no way for the user to tell which.
      throw new AppError('This bot has reached its knowledge capacity', 400);
    }
  }

  const results = await mapWithConcurrency(files, BATCH_CONCURRENCY, async (file) => {
    try {
      return await ingestFile(botId, file, topic, limits, { batchTimeout: true });
    } finally {
      // Every file in the batch is held in the Node heap at once (memoryStorage), so its
      // buffer is released as soon as it has been ingested rather than when the response
      // is finally written (section 12.8). `buffer` is not optional on `UploadedFileLike`
      // because the single-file path always has one — this is a deliberate one-way
      // release, and re-reading it afterwards would be a bug in the caller, not a case to
      // handle here.
      (file as { buffer: Buffer | null }).buffer = null;
    }
  });

  return { results, summary: summarizeUploads(results) };
};

/** A source row as the list returns it: its chunk count, plus how many are enabled. */
export interface SourceListItem extends KnowledgeSource {
  _count: { chunks: number };
  enabledChunks: number;
}

/**
 * List a bot's knowledge sources, after asserting the caller can see the bot.
 *
 * The enabled count is fetched alongside the page rather than per row. Section 15.3's
 * table shows "22 / 24 enabled" next to each document, and a per-row count would be one
 * query per document on a list that already pages twenty at a time. The `groupBy` is
 * scoped to this bot and to `enabled: true`, so it returns at most one row per source on
 * the page — its cost does not grow with the number of chunks.
 */
export const listSources = async (
  botId: string,
  userId: string,
  query: ListSourcesQuery
): Promise<{ sources: SourceListItem[]; total: number }> => {
  await getBotById(botId, userId);

  const where: Prisma.KnowledgeSourceWhereInput = {
    botId,
    ...(query.status ? { status: query.status } : {}),
  };

  const [sources, total, enabledGroups] = await Promise.all([
    prisma.knowledgeSource.findMany({
      where,
      include: { _count: { select: { chunks: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.knowledgeSource.count({ where }),
    prisma.knowledgeChunk.groupBy({
      by: ['sourceId'],
      where: { botId, enabled: true },
      _count: { _all: true },
    }),
  ]);

  const enabledBySource = new Map(
    enabledGroups.map((group) => [group.sourceId, group._count._all])
  );

  return {
    // A source with every chunk disabled has no group at all, so the absence is a zero and
    // not a missing value — the list renders "0 enabled" rather than nothing.
    sources: sources.map((source) => ({
      ...source,
      enabledChunks: enabledBySource.get(source.id) ?? 0,
    })),
    total,
  };
};

/**
 * Fetch one source via the full chain (source → bot → workspace → membership), or throw
 * 404. A non-member gets the same 404 as a source that does not exist.
 */
export const getSourceById = async (
  sourceId: string,
  userId: string
): Promise<SourceWithCounts> => {
  const source = await prisma.knowledgeSource.findFirst({
    where: { id: sourceId, bot: { workspace: { members: { some: { userId } } } } },
    include: { _count: { select: { chunks: true } } },
  });

  if (!source) {
    throw new NotFoundError('Knowledge source not found');
  }

  // Enabled/disabled counts are what the source detail view is for: they answer "how much
  // of this document is actually being used?" without paging through every chunk.
  const [enabledChunks, disabledChunks] = await Promise.all([
    prisma.knowledgeChunk.count({ where: { sourceId, enabled: true } }),
    prisma.knowledgeChunk.count({ where: { sourceId, enabled: false } }),
  ]);

  return { ...source, enabledChunks, disabledChunks };
};

/**
 * Delete a source, its chunk rows, and its vectors.
 *
 * Order is deliberate: the vectors go first. If the AI call fails the row is left intact
 * and the caller gets a 502, so a retry is a straightforward "try again" — the reverse
 * order would delete the row first, and a failed vector deletion would leave vectors
 * permanently unreachable with nothing left to enumerate them from.
 *
 * The `KnowledgeChunk` rows need no explicit delete: the schema cascades them from the
 * source. The vectors do not, because they live in a different database.
 */
export const deleteSource = async (sourceId: string, userId: string): Promise<number> => {
  const source = await getSourceById(sourceId, userId);

  if (source.status === 'PROCESSING') {
    // Deleting now would race the in-flight ingestion, which would go on to write chunk
    // rows and vectors for a source that no longer exists.
    throw new ConflictError('Source is currently being processed and cannot be deleted yet');
  }

  const chunkCount = source._count.chunks;

  let vectorsDeleted = 0;
  try {
    const result = await aiServiceClient.deleteSourceVectors(source.botId, sourceId);
    vectorsDeleted = Number(result?.chunks_deleted ?? 0);
  } catch (err) {
    logger.error({ err, sourceId }, 'Failed to delete source vectors from AI service');
    throw err;
  }

  await prisma.knowledgeSource.delete({ where: { id: sourceId } });

  logger.info({ sourceId, chunkCount, vectorsDeleted }, 'Knowledge source deleted');

  return chunkCount;
};
