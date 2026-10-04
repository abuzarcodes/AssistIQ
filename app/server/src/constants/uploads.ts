/**
 * Upload constants for document knowledge ingestion.
 *
 * The accepted-type lists live here rather than inline in a route so the multer
 * filter, the service-level per-file validation, and the `upload-limits` endpoint
 * all read the same source. Three copies of "pdf and docx" would drift.
 */

/** MIME types the pipeline accepts. */
export const ACCEPTED_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

/** File extensions the pipeline accepts. The Python extractor dispatches on these. */
export const ACCEPTED_EXTENSIONS: readonly string[] = ['.pdf', '.docx'];

/** Human-readable form of the accepted types, for error messages and UI copy. */
export const ACCEPTED_TYPES_LABEL = 'PDF and DOCX';

/**
 * Avatar images (BOT_IMPLEMENTATION_PLAN.md §10.2, §20).
 *
 * Deliberately **not** part of `EffectiveUploadLimits`. Those limits are a per-workspace
 * operator setting, resolved from `PlatformSetting` and advertised by `GET /upload-limits`;
 * an avatar is a fixed product decision — one small square image per bot — and making it
 * operator-tunable would mean a workspace could set a 200 MB avatar ceiling. So these are
 * constants, and the avatar route does not run the `uploadLimits()` middleware at all.
 *
 * 512 KB is generous for a 512×512 avatar in any of the three formats and small enough that
 * buffering it in memory (which is what multer's `memoryStorage` does) is unremarkable.
 */
export const MAX_AVATAR_BYTES = 512 * 1024;

/** MIME types the avatar route accepts on the wire. The bytes are checked separately. */
export const ACCEPTED_AVATAR_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
];

/** Human-readable form of the accepted avatar types, for the 400/415 message. */
export const ACCEPTED_AVATAR_LABEL = 'PNG, JPEG and WebP';
