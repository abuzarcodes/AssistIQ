import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import * as knowledgeChunkService from '../services/knowledgeChunk.service.js';
import {
  listChunksQuerySchema,
  type BulkChunkOperation,
  type KnowledgeTestInput,
  type ListChunksQuery,
} from '../schemas/knowledgeChunk.schema.js';

/**
 * Controllers for knowledge chunk endpoints (section 11.2).
 *
 * Query and body schemas are parsed a second time here, after `validate` has already
 * checked them. That is not redundant: Express's `req.query` accessor is a getter, so the
 * middleware validates in place and cannot write the coerced object back — the handler
 * would still see `'2'` where the schema says `number`. Re-parsing with the same schema
 * is what applies the coercions and defaults, and it keeps the schema the single source of
 * truth for the bounds rather than re-deriving them here. A body is replaced by `validate`
 * (it is a plain property), so only the query needs this treatment.
 */

/** List a bot's chunks, paginated and filtered. */
export const listChunks = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const query = listChunksQuerySchema.parse(req.query) as ListChunksQuery;

  const { chunks, total } = await knowledgeChunkService.listChunks(
    req.params.botId,
    userId,
    query
  );

  sendSuccess(
    res,
    {
      chunks,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    },
    'Knowledge chunks retrieved',
    200
  );
});

/** Fetch one chunk with its source details. */
export const getChunk = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);

  const chunk = await knowledgeChunkService.getChunkById(req.params.chunkId, userId);

  sendSuccess(res, chunk, 'Knowledge chunk retrieved', 200);
});

/**
 * Edit a chunk. A content change re-embeds through the AI service and, if that call
 * fails, throws before Prisma is touched — so the response is a 502 and the chunk still
 * holds its previous content and embedding (section 9.2).
 */
export const updateChunk = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);

  const chunk = await knowledgeChunkService.updateChunk(
    req.params.chunkId,
    userId,
    req.body
  );

  sendSuccess(res, chunk, 'Knowledge chunk updated', 200);
});

/** Delete a chunk and its vector. */
export const deleteChunk = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);

  await knowledgeChunkService.deleteChunk(req.params.chunkId, userId);

  sendSuccess(res, null, 'Chunk deleted', 200);
});

/** Enable, disable, or delete many chunks in one request. */
export const bulkChunks = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  // `validate` replaced `req.body` with the parsed object, so this is the validated form.
  const input = req.body as BulkChunkOperation;

  const { affected } = await knowledgeChunkService.bulkChunkOperation(
    req.params.botId,
    userId,
    input
  );

  sendSuccess(res, { affected }, 'Bulk operation completed', 200);
});

/** Counts for a bot's knowledge overview. */
export const getStats = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);

  const stats = await knowledgeChunkService.getChunkStats(req.params.botId, userId);

  sendSuccess(res, stats, 'Knowledge statistics retrieved', 200);
});

/** Run a retrieval query against this bot — the same search a chat reply performs. */
export const testRetrieval = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const input = req.body as KnowledgeTestInput;

  const result = await knowledgeChunkService.testRetrieval(req.params.botId, userId, input);

  sendSuccess(res, result, 'Retrieval test completed', 200);
});
