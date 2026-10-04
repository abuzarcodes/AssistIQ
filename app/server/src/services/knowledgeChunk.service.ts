import type { KnowledgeChunk, Prisma } from '@prisma/client';
// A value import: the enum is read at runtime to seed `sourcesByStatus` with every
// status, so it cannot be `import type`.
import { KnowledgeSourceStatus } from '@prisma/client';
import prisma from '../config/database.js';
import { AppError, AIServiceError, NotFoundError } from '../utils/errors.js';
import { getBotById } from './bot.service.js';
import { aiServiceClient } from './aiServiceClient.js';
import { logger } from '../config/logger.js';
import type {
  BulkChunkOperation,
  KnowledgeTestInput,
  ListChunksQuery,
  UpdateChunkInput,
} from '../schemas/knowledgeChunk.schema.js';

/** A chunk row plus the source fields the list and detail views render. */
export type ChunkWithSource = KnowledgeChunk & {
  source: { id: string; filename: string };
};

/** The projection of `source` every chunk read includes. */
const SOURCE_SELECT = { select: { id: true, filename: true } } as const;

/** A retrieval hit, enriched with the source filename the vector row cannot carry. */
export interface RetrievalResult {
  chunkId: string;
  content: string;
  score: number;
  pageNumber: number | null;
  sourceId: string | null;
  source: { filename: string } | null;
}

/** Chunk counts for one bot, as the overview page's stat cards render them. */
export interface ChunkStats {
  totalChunks: number;
  enabledChunks: number;
  disabledChunks: number;
  totalSources: number;
  sourcesByStatus: Record<KnowledgeSourceStatus, number>;
}

/** Membership is asserted here, then the read is scoped by `botId`. */
const assertBotAccess = async (botId: string, userId: string): Promise<void> => {
  await getBotById(botId, userId);
};

/**
 * List a bot's chunks, filtered and paginated.
 *
 * `orderBy` is `[chunkIndex, id]` rather than `chunkIndex` alone. `chunkIndex` restarts at
 * 0 for every source, so it is not unique within a bot — and Postgres is free to return
 * ties in any order, and a different one per query. Without the tiebreaker a row can
 * appear on two consecutive pages, or on none, while the total stays correct. The id makes
 * the order total, which is what pagination requires.
 */
export const listChunks = async (
  botId: string,
  userId: string,
  query: ListChunksQuery
): Promise<{ chunks: ChunkWithSource[]; total: number }> => {
  await assertBotAccess(botId, userId);

  const where: Prisma.KnowledgeChunkWhereInput = {
    botId,
    ...(query.sourceId ? { sourceId: query.sourceId } : {}),
    // `undefined` means "no filter", which is not the same as `false` (disabled only).
    ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
    ...(query.search ? { content: { contains: query.search, mode: 'insensitive' } } : {}),
  };

  const [chunks, total] = await Promise.all([
    prisma.knowledgeChunk.findMany({
      where,
      include: { source: SOURCE_SELECT },
      orderBy: [{ chunkIndex: 'asc' }, { id: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.knowledgeChunk.count({ where }),
  ]);

  return { chunks, total };
};

/**
 * Fetch one chunk via the full chain (chunk → bot → workspace → membership), or throw
 * 404. A non-member gets the same 404 as a chunk that does not exist.
 */
export const getChunkById = async (
  chunkId: string,
  userId: string
): Promise<ChunkWithSource> => {
  const chunk = await prisma.knowledgeChunk.findFirst({
    where: { id: chunkId, bot: { workspace: { members: { some: { userId } } } } },
    include: { source: SOURCE_SELECT },
  });

  if (!chunk) {
    throw new NotFoundError('Knowledge chunk not found');
  }

  return chunk;
};

/**
 * Edit a chunk's content and/or enabled state.
 *
 * **Ordering: the vector is written before the mirror row.** Every mutation in this file
 * does its remote write first and its local one second, so a failure at either step is
 * reported (502) with the row left describing *older* state — recoverable by retrying, as
 * section 19.3 sets out. The reverse order fails worse: if the AI call fails after the row
 * was written, the row claims content the embedding does not represent, or says disabled
 * while retrieval is still serving the chunk — and neither is detectable by looking at the
 * row, so a retry has nothing to correct. Section 8.3 draws the toggle the Prisma-first
 * way; that is corrected here for this reason.
 *
 * A content edit that does not change the text is a no-op: re-embedding identical content
 * costs a provider call and bumps `version` for a change that never happened.
 */
export const updateChunk = async (
  chunkId: string,
  userId: string,
  input: UpdateChunkInput
): Promise<ChunkWithSource> => {
  const chunk = await getChunkById(chunkId, userId);
  const data: Prisma.KnowledgeChunkUpdateInput = {};

  if (input.content !== undefined && input.content !== chunk.content) {
    // The AI service leaves the stored vector untouched if it cannot embed the new text,
    // so reaching the next line means the vector and `input.content` already agree.
    const embedded = await aiServiceClient.reEmbedChunk(chunk.botId, chunkId, input.content);

    data.content = input.content;
    // `version` tracks content history (section 9.3). Only a content change is a new
    // version; a toggle is not.
    data.version = { increment: 1 };
    data.embeddingModel = embedded.embedding_model;
    data.embeddingDimension = embedded.embedding_dimension;
    data.lastEmbeddedAt = new Date();
  }

  if (input.enabled !== undefined && input.enabled !== chunk.enabled) {
    await aiServiceClient.toggleChunkEnabled(chunk.botId, chunkId, input.enabled);
    data.enabled = input.enabled;
  }

  if (Object.keys(data).length === 0) {
    // Nothing to change — the caller sent the values the chunk already has. Returning the
    // row as-is keeps the endpoint idempotent instead of issuing a write that would bump
    // `updatedAt` for no reason.
    return chunk;
  }

  const updated = await prisma.knowledgeChunk.update({
    where: { id: chunkId },
    data,
    include: { source: SOURCE_SELECT },
  });

  logger.info(
    { chunkId, botId: chunk.botId, reEmbedded: data.content !== undefined },
    'Knowledge chunk updated'
  );

  return updated;
};

/**
 * Delete one chunk: its vector first, then the mirror row (section 10.1).
 *
 * Same ordering rule as `updateChunk`, for the same reason: the row is what identifies
 * the vector, so deleting it first would leave a vector nothing can enumerate — still
 * retrieved, and unreachable by any future delete.
 */
export const deleteChunk = async (chunkId: string, userId: string): Promise<ChunkWithSource> => {
  const chunk = await getChunkById(chunkId, userId);

  try {
    await aiServiceClient.deleteChunkVector(chunk.botId, chunkId);
  } catch (err) {
    // Already absent is not a failure. The AI service answers 404 when no vector matches
    // this id, and the caller asked for the chunk to be gone — which it is. Reporting an
    // error here would leave the row permanently undeletable: every retry would fetch the
    // same row, call the same endpoint, and get the same 404 back (section 18.13).
    //
    // Only a 404 is absorbed. A timeout or a 5xx means the vector may well still exist,
    // and deleting the row then would strand it beyond reach — the exact outcome the
    // ordering rule above exists to prevent.
    if (!(err instanceof AIServiceError && err.upstreamStatus === 404)) {
      throw err;
    }

    logger.warn(
      { chunkId, botId: chunk.botId },
      'Vector already absent from the AI service; deleting the mirror row anyway'
    );
  }

  await prisma.knowledgeChunk.delete({ where: { id: chunkId } });

  logger.info({ chunkId, botId: chunk.botId }, 'Knowledge chunk deleted');

  return chunk;
};

/**
 * Apply one action to many chunks (section 11.2).
 *
 * The ownership check is the point of this function. The AI service already scopes every
 * statement by `bot_id`, so a foreign id would be a silent no-op there — and a request
 * that reports "12 chunks disabled" while three of them belonged to another tenant is
 * worse than a rejection: the count is a lie the caller cannot detect. So the ids are
 * verified against this bot *before* anything is written, and any id that does not belong
 * is a 400 with nothing changed.
 *
 * Duplicate ids are collapsed rather than rejected. A client that double-selects a row has
 * made a UI slip, not a request that should fail — and the deduplication is what makes the
 * `owned.length !== ids.length` comparison meaningful.
 */
export const bulkChunkOperation = async (
  botId: string,
  userId: string,
  input: BulkChunkOperation
): Promise<{ affected: number }> => {
  await assertBotAccess(botId, userId);

  const ids = [...new Set(input.chunkIds)];

  const owned = await prisma.knowledgeChunk.findMany({
    where: { id: { in: ids }, botId },
    select: { id: true },
  });

  if (owned.length !== ids.length) {
    throw new AppError('Some chunks do not belong to this bot', 400);
  }

  if (input.action === 'delete') {
    await aiServiceClient.bulkDeleteChunks(botId, ids);
    const { count } = await prisma.knowledgeChunk.deleteMany({ where: { id: { in: ids }, botId } });

    logger.info({ botId, count }, 'Knowledge chunks bulk deleted');

    return { affected: count };
  }

  const enabled = input.action === 'enable';
  await aiServiceClient.bulkToggleChunks(botId, ids, enabled);

  const { count } = await prisma.knowledgeChunk.updateMany({
    where: { id: { in: ids }, botId },
    data: { enabled },
  });

  logger.info({ botId, count, enabled }, 'Knowledge chunks bulk toggled');

  return { affected: count };
};

/**
 * Counts for the overview page's stat cards.
 *
 * `sourcesByStatus` is built from the enum rather than from the grouped rows, so a status
 * with no sources is present as `0` instead of missing. The client renders four badges;
 * making it supply a fallback for each would be the client re-deriving a server enum.
 */
export const getChunkStats = async (botId: string, userId: string): Promise<ChunkStats> => {
  await assertBotAccess(botId, userId);

  const [totalChunks, enabledChunks, totalSources, grouped] = await Promise.all([
    prisma.knowledgeChunk.count({ where: { botId } }),
    prisma.knowledgeChunk.count({ where: { botId, enabled: true } }),
    prisma.knowledgeSource.count({ where: { botId } }),
    prisma.knowledgeSource.groupBy({
      by: ['status'],
      where: { botId },
      _count: { _all: true },
    }),
  ]);

  const sourcesByStatus = Object.fromEntries(
    Object.values(KnowledgeSourceStatus).map((status) => [status, 0])
  ) as Record<KnowledgeSourceStatus, number>;

  for (const row of grouped) {
    sourcesByStatus[row.status] = row._count._all;
  }

  return {
    totalChunks,
    enabledChunks,
    // Derived, so the three counts can never disagree with each other.
    disabledChunks: totalChunks - enabledChunks,
    totalSources,
    sourcesByStatus,
  };
};

/**
 * Run a retrieval query against one bot's knowledge (section 11.3).
 *
 * The vector row carries no filename — it stores `source_id` in its metadata — so the
 * document names are resolved from Prisma in a second, bot-scoped query. The lookup is
 * deliberately a plain map-miss rather than an error: FAQ-derived vectors also carry a
 * `source_id` (the knowledge entry's id), which no `knowledge_sources` row will match, and
 * a retrieval test that 500s because a legacy chunk was returned would be reporting the
 * wrong thing. Those results come back with `source: null`.
 *
 * Only enabled chunks can appear: the AI service filters `enabled = true` in SQL (section
 * 8.5), which is what makes this endpoint show the same content a chat reply would use.
 */
export const testRetrieval = async (
  botId: string,
  userId: string,
  input: KnowledgeTestInput
): Promise<{ query: string; results: RetrievalResult[] }> => {
  await assertBotAccess(botId, userId);

  const response = await aiServiceClient.searchVectors({
    bot_id: botId,
    query: input.query,
    top_k: input.topK,
  });

  const hits = (response?.results ?? []) as Array<{
    id?: string;
    content?: string;
    score?: number;
    metadata?: { page_number?: number | null; source_id?: string | null };
  }>;

  const sourceIds = [
    ...new Set(
      hits
        .map((hit) => hit.metadata?.source_id)
        .filter((id): id is string => typeof id === 'string')
    ),
  ];

  const sources = sourceIds.length
    ? await prisma.knowledgeSource.findMany({
        where: { id: { in: sourceIds }, botId },
        select: { id: true, filename: true },
      })
    : [];

  const filenameById = new Map(sources.map((source) => [source.id, source.filename]));

  const results: RetrievalResult[] = hits.map((hit) => {
    const sourceId = hit.metadata?.source_id ?? null;
    const filename = sourceId ? filenameById.get(sourceId) : undefined;

    return {
      chunkId: hit.id ?? '',
      content: hit.content ?? '',
      score: hit.score ?? 0,
      pageNumber: hit.metadata?.page_number ?? null,
      sourceId,
      source: filename ? { filename } : null,
    };
  });

  return { query: input.query, results };
};
