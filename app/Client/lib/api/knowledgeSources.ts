import { apiGet, apiDelete, apiPostFormData, ApiError } from '@/lib/api-client';

/**
 * Knowledge-source endpoints (`/bots/:botId/knowledge-sources`, `/knowledge-sources/:id`).
 *
 * Mirrors the server's types rather than importing them: the client and server are
 * separate packages with no shared type project, and a build-time import across them
 * would be the only thing coupling their deploy order.
 */

/** The persisted ingestion lifecycle. `REJECTED` is deliberately not a member. */
export type KnowledgeSourceStatus = 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED';

/**
 * One file's outcome in an upload.
 *
 * `REJECTED` exists only in the response: the file never entered the pipeline, so there
 * is no source row to look up afterwards.
 */
export type UploadOutcome = 'PROCESSED' | 'FAILED' | 'REJECTED';

export interface KnowledgeSource {
  id: string;
  botId: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  status: KnowledgeSourceStatus;
  pagesExtracted: number | null;
  chunksCreated: number | null;
  errorMessage: string | null;
  topic: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A source as the list endpoint returns it: the row plus its chunk counts.
 *
 * `enabledChunks` is not derived by counting the chunk list — the server groups the counts
 * for the whole page in one query, because a per-row count would be twenty extra requests
 * per page (section 15.3's "22 / 24 enabled" column).
 */
export interface SourceListItem extends KnowledgeSource {
  _count: { chunks: number };
  enabledChunks: number;
}

export interface SourceWithCounts extends SourceListItem {
  disabledChunks: number;
}

/**
 * The limits the server will actually enforce, for the picker's pre-flight checks.
 *
 * These are advisory — the server re-checks everything and is the authority. Rendering
 * them from the response rather than from constants means an operator's change is visible
 * on the next dialog open, with no client release (section 12.5).
 */
export interface EffectiveUploadLimits {
  maxFileSizeBytes: number;
  maxFilesPerRequest: number;
  maxTotalBytes: number;
  maxChunksPerSource: number;
  maxChunksPerBot: number;
  acceptedMimeTypes: string[];
  acceptedExtensions: string[];
}

export interface UploadResultItem {
  filename: string;
  outcome: UploadOutcome;
  /** Present for `PROCESSED` and `FAILED`; absent for `REJECTED`, which has no row. */
  sourceId?: string;
  chunksCreated?: number;
  pagesExtracted?: number;
  error?: string;
}

export interface UploadSummary {
  total: number;
  processed: number;
  failed: number;
  rejected: number;
}

export interface UploadBatchResult {
  results: UploadResultItem[];
  summary: UploadSummary;
}

export interface SourceListPage {
  sources: SourceListItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export function listSources(
  botId: string,
  params?: { status?: KnowledgeSourceStatus; page?: number; limit?: number },
) {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));

  const suffix = query.toString() ? `?${query.toString()}` : '';
  return apiGet<SourceListPage>(`/bots/${botId}/knowledge-sources${suffix}`);
}

export function getSource(sourceId: string) {
  return apiGet<SourceWithCounts>(`/knowledge-sources/${sourceId}`);
}

export function getUploadLimits(botId: string) {
  return apiGet<EffectiveUploadLimits>(`/bots/${botId}/knowledge-sources/upload-limits`);
}

/**
 * Upload 1..maxFilesPerRequest documents in one request.
 *
 * One request, not a loop of single-file calls: the server applies the combined-size and
 * file-count rules to the batch as a whole, so a loop would let a client exceed limits the
 * server means to enforce together (section 12.6).
 *
 * No client-side timeout is set. The request can legitimately run for minutes, and an
 * `AbortController` on a timer would either fire on a healthy batch or be so long it is
 * not a timeout — the server's own batch timeout (section 12.8) is the bound that matters.
 */
export function uploadSources(botId: string, files: File[], topic?: string) {
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  if (topic) {
    formData.append('topic', topic);
  }
  return apiPostFormData<UploadBatchResult>(
    `/bots/${botId}/knowledge-sources/upload`,
    formData,
  );
}

export function deleteSource(sourceId: string) {
  return apiDelete<null>(`/knowledge-sources/${sourceId}`);
}

/**
 * The per-file reasons from an "every file was rejected" 400 (section 12.6).
 *
 * A batch where nothing was accepted is an error response, not a success with an empty
 * result list, so the reasons arrive nested in the error envelope. Digging them out here
 * keeps that shape in one place instead of in every caller that renders an upload failure.
 * Returns null for anything that is not that specific response.
 */
export function rejectionDetails(error: unknown): UploadBatchResult | null {
  if (!(error instanceof ApiError)) return null;

  const envelope = error.data as { data?: UploadBatchResult } | undefined;
  const details = envelope?.data;

  return details && Array.isArray(details.results) ? details : null;
}
