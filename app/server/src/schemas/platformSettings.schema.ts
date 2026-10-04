import { z } from 'zod';

/**
 * Validation for `PATCH /platform/settings` (section 12.11).
 *
 * Two layers, because a PATCH is partial and the invariants are relational:
 *
 *  1. `updateSettingsSchema` bounds each field independently and rejects an empty body.
 *     It cannot check the cross-field rules — a patch that supplies only
 *     `maxUploadTotalBytes` has nothing to compare against until it is merged with the
 *     stored row.
 *  2. `settingsInvariantsSchema` is the same six fields, all required, refined against
 *     each other. The service parses the *merged* candidate through it before writing, so
 *     the invariants are declared once, in Zod, and hold for every write regardless of
 *     which subset the client sent.
 *
 * The maximums are not cosmetic: `memoryStorage` holds an entire request in the Node heap
 * (section 12.8), so these caps are the ceiling on what one upload can cost the process.
 */

const MB = 1024 * 1024;

/** The six operator-settable limits, with the bounds each is allowed to take. */
const limitFields = {
  /** One file's heap and the AI service's memory. */
  maxUploadFileSizeBytes: z.number().int().min(1 * MB).max(100 * MB),
  /** Per-request concurrency and round trips; also the batch timeout's multiplier. */
  maxUploadFilesPerRequest: z.number().int().min(1).max(50),
  /** The combined heap a single request may claim. */
  maxUploadTotalBytes: z.number().int().min(1 * MB).max(500 * MB),
  /** Bounds embedding spend per document. */
  maxChunksPerSource: z.number().int().min(1).max(50_000),
  /** 0 means unlimited — a cap expressed as a cap, not a sentinel for "none allowed". */
  maxChunksPerBot: z.number().int().min(0).max(1_000_000),
  /** The AI service's absolute backstop; never a second configuration surface. */
  aiServiceMaxFileSizeBytes: z.number().int().min(1 * MB).max(500 * MB),
} as const;

export const updateSettingsSchema = z
  .object({
    maxUploadFileSizeBytes: limitFields.maxUploadFileSizeBytes.optional(),
    maxUploadFilesPerRequest: limitFields.maxUploadFilesPerRequest.optional(),
    maxUploadTotalBytes: limitFields.maxUploadTotalBytes.optional(),
    maxChunksPerSource: limitFields.maxChunksPerSource.optional(),
    maxChunksPerBot: limitFields.maxChunksPerBot.optional(),
    aiServiceMaxFileSizeBytes: limitFields.aiServiceMaxFileSizeBytes.optional(),
  })
  // An empty PATCH is a client mistake, not a no-op — same rule as
  // `PATCH /knowledge-chunks/:chunkId`. Returning 200 would tell the caller its change
  // was applied when nothing was sent.
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Provide at least one setting to update',
  });

/**
 * The relational rules, checked on the fully-merged settings object.
 *
 * Each one rejects a configuration that is internally contradictory rather than merely
 * unusual — the message names both fields so the operator can see which pair conflicts.
 */
export const settingsInvariantsSchema = z
  .object({
    maxUploadFileSizeBytes: limitFields.maxUploadFileSizeBytes,
    maxUploadFilesPerRequest: limitFields.maxUploadFilesPerRequest,
    maxUploadTotalBytes: limitFields.maxUploadTotalBytes,
    maxChunksPerSource: limitFields.maxChunksPerSource,
    maxChunksPerBot: limitFields.maxChunksPerBot,
    aiServiceMaxFileSizeBytes: limitFields.aiServiceMaxFileSizeBytes,
  })
  .refine((s) => s.maxUploadTotalBytes >= s.maxUploadFileSizeBytes, {
    message:
      'maxUploadTotalBytes must be greater than or equal to maxUploadFileSizeBytes, ' +
      'otherwise no single allowed file could ever be uploaded',
    path: ['maxUploadTotalBytes'],
  })
  .refine((s) => s.aiServiceMaxFileSizeBytes >= s.maxUploadFileSizeBytes, {
    message:
      'aiServiceMaxFileSizeBytes must be greater than or equal to maxUploadFileSizeBytes, ' +
      'otherwise the AI service would reject files the server accepted',
    path: ['aiServiceMaxFileSizeBytes'],
  });

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
/** The six limits after merging, as stored. */
export type SettingsLimits = z.infer<typeof settingsInvariantsSchema>;
