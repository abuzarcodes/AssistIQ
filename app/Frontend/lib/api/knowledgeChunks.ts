import { apiGet, apiDelete, apiPatch, apiPost } from '@/lib/api-client';
import type { KnowledgeSourceStatus } from '@/lib/api/knowledgeSources';

/**
 * Knowledge-chunk endpoints (`/bots/:botId/knowledge-chunks`, `/knowledge-chunks/:id`).
 *
 * Mirrors the server's types rather than importing them — the two packages share no type
 * project, and a build-time import would couple their deploy order for nothing.
 *
 * `KnowledgeSourceStatus` is the exception: it is re-used from the sources module rather
 * than declared twice, because the two copies would have to agree about an enum the
 * *server* owns, and nothing would catch it if they stopped.
 */

/**
 * A chunk as the API returns it.
 *
 * `source` is always present: every read includes it, because a chunk's text is only
 * meaningful next to the document it came from — "Refunds take five days" is a different
 * claim depending on which handbook said it.
 */
export interface KnowledgeChunk {
  id: string;
  sourceId: string;
  botId: string;
  content: string;
  chunkIndex: number;
  pageNumber: number | null;
  section: string | null;
  topic: string | null;
  enabled: boolean;
  /** Increments on every content edit. Unchanged by a toggle (section 9.3). */
  version: number;
  embeddingModel: string | null;
  embeddingDimension: number | null;
  lastEmbeddedAt: string | null;
  createdAt: string;
  updatedAt: string;
  source: { id: string; filename: string };
}

export interface ChunkListFilters {
  /** Substring match on the chunk text. */
  search?: string;
  sourceId?: string;
  /**
   * `undefined` means "no filter". It is not the same as `false`, which asks for disabled
   * chunks only — so the filter is only sent when the caller has actually chosen one.
   */
  enabled?: boolean;
  page?: number;
  limit?: number;
}

export interface ChunkListPage {
  chunks: KnowledgeChunk[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface ChunkStats {
  totalChunks: number;
  enabledChunks: number;
  disabledChunks: number;
  totalSources: number;
  sourcesByStatus: Record<KnowledgeSourceStatus, number>;
}

export interface RetrievalResult {
  chunkId: string;
  content: string;
  score: number;
  pageNumber: number | null;
  sourceId: string | null;
  /**
   * Null when the hit did not come from an uploaded document — FAQ-derived vectors carry
   * a knowledge entry's id, which no source row matches. That is a normal result.
   */
  source: { filename: string } | null;
}

export type BulkChunkAction = 'enable' | 'disable' | 'delete';

/**
 * List a bot's chunks.
 *
 * Only the filters the caller set are sent: an omitted `enabled` and `enabled=false` mean
 * different things to the server (all chunks vs. disabled ones), so sending a default would
 * silently apply a filter nobody asked for.
 */
export function listChunks(botId: string, filters?: ChunkListFilters) {
  const query = new URLSearchParams();
  if (filters?.search) query.set('search', filters.search);
  if (filters?.sourceId) query.set('sourceId', filters.sourceId);
  if (filters?.enabled !== undefined) query.set('enabled', String(filters.enabled));
  if (filters?.page) query.set('page', String(filters.page));
  if (filters?.limit) query.set('limit', String(filters.limit));

  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiGet<ChunkListPage>(`/bots/${botId}/knowledge-chunks${suffix}`);
}

export function getChunk(chunkId: string) {
  return apiGet<KnowledgeChunk>(`/knowledge-chunks/${chunkId}`);
}

/**
 * Edit a chunk's content and/or enabled state.
 *
 * Sending `content` triggers re-embedding through the AI service, which can take a moment
 * and can fail — a failed re-embed is a 502 and the chunk keeps its previous content
 * (section 9.2). A body with neither field is a 400, so callers must send at least one.
 */
export function updateChunk(
  chunkId: string,
  data: { content?: string; enabled?: boolean },
) {
  return apiPatch<KnowledgeChunk>(`/knowledge-chunks/${chunkId}`, data);
}

export function deleteChunk(chunkId: string) {
  return apiDelete<null>(`/knowledge-chunks/${chunkId}`);
}

/**
 * Apply one action to up to 100 chunks.
 *
 * The server rejects the whole request if any id belongs to another bot, rather than
 * skipping it, so a partial success cannot be reported as a full one.
 */
export function bulkChunkAction(
  botId: string,
  action: BulkChunkAction,
  chunkIds: string[],
) {
  return apiPost<{ affected: number }>(`/bots/${botId}/knowledge-chunks/bulk`, {
    action,
    chunkIds,
  });
}

export function getChunkStats(botId: string) {
  return apiGet<ChunkStats>(`/bots/${botId}/knowledge-chunks/stats`);
}

/**
 * Run a retrieval query against this bot — the same search a chat reply performs, so what
 * it returns is what the bot would have used (disabled chunks are excluded in SQL).
 */
export function testRetrieval(botId: string, query: string, topK?: number) {
  return apiPost<{ query: string; results: RetrievalResult[] }>(
    `/bots/${botId}/knowledge-test`,
    { query, ...(topK ? { topK } : {}) },
  );
}
