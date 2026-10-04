import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import * as knowledgeSourceService from '../services/knowledgeSource.service.js';
import { getBotById } from '../services/bot.service.js';
import { AppError } from '../utils/errors.js';
import { listSourcesQuerySchema, type ListSourcesQuery } from '../schemas/knowledgeSource.schema.js';
import type { EffectiveUploadLimits } from '../types/knowledge.types.js';

/**
 * Upload one or more documents as knowledge sources.
 *
 * One handler covers both cases because a batch of one file *is* the single-file case —
 * §12.6 defines the request as `files` repeated 1..maxFilesPerRequest. Splitting them
 * would duplicate the whole lifecycle for no gain.
 *
 * The per-file outcomes decide the status code (section 12.6):
 *   - at least one file entered the pipeline → **201**, with the full per-file results
 *   - every file was rejected            → **400**, with the per-file reasons
 * A request-level violation (too many files, combined size, quota) never reaches here —
 * `ingestBatch` throws before touching a file, so the response is a single 400 error.
 *
 * Note that a `FAILED` file is still a 201: the request was valid and the batch was
 * partially successful. Failing the whole request because one document was unreadable
 * would throw away the work already done on its siblings.
 */
export const uploadSources = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const botId = req.params.botId;

  // `req.files` is only an array on the batch route; `documentUpload(..., 'batch')` is what
  // guarantees that, and the single-item form is normalised here so the handler has one
  // shape to reason about.
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) {
    throw new AppError('At least one file is required', 400);
  }

  // Membership is asserted before any ingestion work, and the bot's id is taken from the
  // row rather than the path. `ingestBatch` does not check membership — it is an internal
  // function that assumes its caller has — so the guard has to be here.
  const bot = await getBotById(botId, userId);

  // Resolved by the `uploadLimits` middleware, which the route runs after the permission
  // guard. Absence here is a middleware-order bug, not a client error.
  const limits = req.uploadLimits;
  if (!limits) {
    throw new AppError('Upload limits were not resolved for this request', 500);
  }

  const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : undefined;

  const { results, summary } = await knowledgeSourceService.ingestBatch(
    bot.id,
    files,
    topic || undefined,
    limits
  );

  if (summary.processed === 0 && summary.failed === 0) {
    // Nothing entered the pipeline, so there is no batch to report on — only reasons.
    // The reasons travel in `details` so the client gets the same `{ results, summary }`
    // shape it would have received from a 201, rather than having to parse prose.
    throw new AppError(
      'No files were accepted',
      400,
      true,
      { results, summary }
    );
  }

  sendSuccess(res, { results, summary }, 'Documents uploaded', 201);
});

/**
 * The limits that apply to this bot's uploads, for the client's pre-flight checks.
 *
 * The client is never authoritative (section 12.5) — a crafted request bypasses it — but
 * it needs the numbers to render "up to N files, X MB each" and to refuse an oversized
 * file without a round trip. Serving them from the resolver means a settings change is
 * visible to the UI on the next page load, with no client release.
 */
export const getUploadLimits = asyncHandler(async (req: Request, res: Response) => {
  const limits: EffectiveUploadLimits | undefined = req.uploadLimits;

  if (!limits) {
    throw new AppError('Upload limits were not resolved for this request', 500);
  }

  sendSuccess(res, limits, 'Upload limits retrieved', 200);
});

/** List a bot's knowledge sources, paginated and optionally filtered by status. */
export const listSources = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  // `validate` checks the query in place and discards the parse result — Express's query
  // accessor is a getter, so the middleware cannot write the coerced object back. Parsing
  // again here is what turns `'2'` into `2` and applies the defaults; the schema stays the
  // single source of truth for the bounds, so this cannot drift from what was validated.
  const query = listSourcesQuerySchema.parse(req.query) as ListSourcesQuery;

  const { sources, total } = await knowledgeSourceService.listSources(
    req.params.botId,
    userId,
    query
  );

  sendSuccess(
    res,
    {
      sources,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    },
    'Knowledge sources retrieved',
    200
  );
});

/** Fetch one source with its chunk counts. */
export const getSource = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);

  const source = await knowledgeSourceService.getSourceById(req.params.sourceId, userId);

  sendSuccess(res, source, 'Knowledge source retrieved', 200);
});

/** Delete a source, its chunk rows, and its vectors. */
export const deleteSource = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);

  const chunkCount = await knowledgeSourceService.deleteSource(req.params.sourceId, userId);

  sendSuccess(res, null, `Source and ${chunkCount} chunks deleted`, 200);
});
