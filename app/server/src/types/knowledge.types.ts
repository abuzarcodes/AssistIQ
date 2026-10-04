/**
 * Shared types for document knowledge management.
 *
 * These live outside the service modules because they cross layers: the settings
 * service resolves `UploadLimits`, the source service consumes them, and the
 * controllers return `UploadResultItem[]`. A type owned by one service and imported by
 * the others would make the dependency direction lie.
 */

/**
 * Effective upload limits for one request.
 *
 * Resolved from `PlatformSetting` (section 12.4) rather than read directly, so that
 * adding subscription-tier limits later changes only the resolver — every enforcement
 * point already takes this object as an argument.
 */
export interface UploadLimits {
  /** Largest single file, in bytes. */
  maxFileSizeBytes: number;
  /** Largest number of files in one request. */
  maxFilesPerRequest: number;
  /** Largest combined size of all files in one request, in bytes. */
  maxTotalBytes: number;
  /** Largest number of chunks one source may produce. */
  maxChunksPerSource: number;
}

/**
 * Everything `resolveUploadLimits()` returns (section 12.4).
 *
 * Adds the two limits that are enforced *outside* per-file ingestion — the per-bot
 * lifetime quota and the accepted-type lists — so a caller that needs a complete picture
 * (the `upload-limits` endpoint, the multer factory) does not have to consult
 * `constants/uploads.ts` separately.
 *
 * `UploadLimits` stays the narrower type that `ingestFile` takes, so the ingestion
 * function cannot start depending on limits it has no use for.
 */
export interface EffectiveUploadLimits extends UploadLimits {
  /** Total chunks a bot may hold, across all sources. 0 means unlimited. */
  maxChunksPerBot: number;
  /**
   * Accepted MIME types and extensions, carried on the resolved object rather than read
   * from the constants at each call site: when tiers arrive, a tier could accept a
   * different set, and that must not require touching the enforcement points.
   */
  acceptedMimeTypes: string[];
  acceptedExtensions: string[];
}

/**
 * Outcome of one file in an upload.
 *
 * `REJECTED` is deliberately **not** a `KnowledgeSourceStatus`. The enum describes a
 * persisted lifecycle; `REJECTED` describes a file that never entered the pipeline and
 * has no row at all. Adding it to the enum would mean writing a `FAILED`-looking source
 * for a file that was never read, cluttering the list with entries the user cannot act
 * on (section 12.6).
 */
export type UploadOutcome = 'PROCESSED' | 'FAILED' | 'REJECTED';

/** Per-file result of an upload. */
export interface UploadResultItem {
  filename: string;
  outcome: UploadOutcome;
  /** Present for `PROCESSED` and `FAILED`; absent for `REJECTED`, which has no row. */
  sourceId?: string;
  chunksCreated?: number;
  pagesExtracted?: number;
  /** Why the file failed or was rejected. Absent on success. */
  error?: string;
}

/** Aggregate counts across one upload. */
export interface UploadSummary {
  total: number;
  processed: number;
  failed: number;
  rejected: number;
}

/** Count the outcomes in a batch of per-file results. */
export const summarizeUploads = (results: UploadResultItem[]): UploadSummary => ({
  total: results.length,
  processed: results.filter((r) => r.outcome === 'PROCESSED').length,
  failed: results.filter((r) => r.outcome === 'FAILED').length,
  rejected: results.filter((r) => r.outcome === 'REJECTED').length,
});
