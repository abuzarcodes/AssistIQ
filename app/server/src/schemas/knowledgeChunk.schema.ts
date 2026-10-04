import { z } from 'zod';

/**
 * Validation schemas for knowledge chunk endpoints (section 11.2).
 *
 * `enabled` arrives as a query string, so it is declared as the two literals a query can
 * actually carry and narrowed to a boolean here. `z.coerce.boolean()` would be wrong:
 * it maps the string `"false"` to `true`, because any non-empty string is truthy — so
 * `?enabled=false` would silently filter for enabled chunks.
 */

export const chunkIdParamSchema = z.object({
  chunkId: z.string().uuid('Invalid knowledge chunk id'),
});

/**
 * List query. `limit` is capped at 100 for the same reason the source list is: an
 * uncapped page size is a request that can ask the database for every chunk a bot owns.
 */
export const listChunksQuerySchema = z.object({
  /**
   * Substring match on `content`. An empty value is accepted and treated as "no filter"
   * rather than a 400: a search box that is cleared sends `?search=` far more often than
   * it omits the key, and refusing that would make the client responsible for a detail it
   * should not have to know.
   */
  search: z.string().trim().max(200).optional(),
  sourceId: z.string().uuid('Invalid knowledge source id').optional(),
  enabled: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListChunksQuery = z.infer<typeof listChunksQuerySchema>;

/**
 * Edit body: content, enabled state, or both (section 11.2).
 *
 * `content` is trimmed before the length check, so a body of only whitespace is a 400
 * rather than a chunk whose text is invisible. The 10 000-character ceiling is the plan's;
 * it is well above the chunker's own target size, so it only ever catches a paste that
 * was never meant to be one chunk.
 */
export const updateChunkSchema = z
  .object({
    content: z.string().trim().min(1, 'Content cannot be empty').max(10000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((body) => body.content !== undefined || body.enabled !== undefined, {
    message: 'Provide content, enabled, or both',
  });

export type UpdateChunkInput = z.infer<typeof updateChunkSchema>;

/** Bulk action body. The 100-id ceiling is the plan's (section 11.2). */
export const bulkChunkOperationSchema = z.object({
  action: z.enum(['enable', 'disable', 'delete']),
  chunkIds: z
    .array(z.string().uuid('Invalid chunk id'))
    .min(1, 'At least one chunk id is required')
    .max(100, 'At most 100 chunks may be changed at once'),
});

export type BulkChunkOperation = z.infer<typeof bulkChunkOperationSchema>;

/** Retrieval test body (section 11.3). */
export const knowledgeTestSchema = z.object({
  query: z.string().trim().min(1, 'A query is required').max(1000),
  topK: z.number().int().min(1).max(20).default(5),
});

export type KnowledgeTestInput = z.infer<typeof knowledgeTestSchema>;
