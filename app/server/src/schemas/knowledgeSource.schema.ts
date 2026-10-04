import { z } from 'zod';
import { KnowledgeSourceStatus } from '@prisma/client';

/**
 * Validation schemas for knowledge source endpoints.
 *
 * `knowledgeSourceStatusSchema` is built from the Prisma enum rather than a hand-written
 * union, so a status added to the schema cannot be silently rejected by the API — and,
 * more importantly, `REJECTED` cannot be accepted as a filter for a value that is never
 * persisted (section 12.6).
 */
export const knowledgeSourceStatusSchema = z.nativeEnum(KnowledgeSourceStatus);

export const sourceIdParamSchema = z.object({
  sourceId: z.string().uuid('Invalid knowledge source id'),
});

/**
 * List query. `limit` is capped at 100: an uncapped page size is a request that can ask
 * the database for every source a bot owns, and the client has no use for them all at once.
 */
export const listSourcesQuerySchema = z.object({
  status: knowledgeSourceStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListSourcesQuery = z.infer<typeof listSourcesQuerySchema>;
