import type { PlatformSetting } from '@prisma/client';
import prisma from '../config/database.js';
import { AppError } from '../utils/errors.js';
import { settingsInvariantsSchema, type UpdateSettingsInput } from '../schemas/platformSettings.schema.js';
import { ACCEPTED_EXTENSIONS, ACCEPTED_MIME_TYPES } from '../constants/uploads.js';
import type { EffectiveUploadLimits } from '../types/knowledge.types.js';

/**
 * Platform settings: storage, resolution, and caching (sections 12.3–12.4).
 *
 * This module is the **only** place that reads `prisma.platformSetting`. Controllers and
 * middleware must go through `resolveUploadLimits()` — that restriction is what makes the
 * subscription-tier seam real (section 12.10): when tiers arrive, only the resolver's body
 * changes, because every enforcement point already receives the resolved object.
 */

/** How long a resolved settings read may be reused. See `getSettings` for the trade-off. */
const CACHE_TTL_MS = 60_000;

/**
 * One-entry cache. The underlying value is global in v1, so keying it by workspace would
 * cache the same object N times; a keyed cache is added when tiers make the value
 * per-workspace, not before.
 */
let cache: { settings: PlatformSetting; expiresAt: number } | null = null;

/** Drop the cached settings. Called after a successful write. */
export const invalidateSettingsCache = (): void => {
  cache = null;
};

/**
 * Read the row, creating it with schema defaults if it is absent.
 *
 * Upsert-on-read rather than a bare `findUnique`: a fresh database, or one where the seed
 * was skipped, must not be able to produce a "no limits configured" state. The migration
 * also seeds the row, so this is a safety net rather than the normal path.
 *
 * Deliberately uncached — callers decide whether a cached value is acceptable.
 */
const readSettings = async (): Promise<PlatformSetting> =>
  prisma.platformSetting.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton' },
  });

/**
 * Read the settings, served from a short-lived cache when one is warm.
 *
 * TTL is 60 s. The value is not security-critical (it caps upload size, it does not grant
 * access), so bounded staleness is the right trade for not paying a query on every upload
 * request. With several API instances, a `PATCH` invalidates the instance that served it
 * and the others converge within the TTL.
 */
export const getSettings = async (): Promise<PlatformSetting> => {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.settings;
  }

  const settings = await readSettings();
  cache = { settings, expiresAt: Date.now() + CACHE_TTL_MS };
  return settings;
};

/**
 * Apply a partial update, rejecting any change that would leave the settings
 * self-contradictory (section 12.11).
 *
 * The merge happens against a **fresh** read, not the cache. Validating a write against a
 * possibly-stale row is how a patch that is valid on its own can produce an invalid stored
 * configuration: with a cached `maxUploadFileSizeBytes` of 10 MB, a patch setting
 * `maxUploadTotalBytes` to 20 MB would pass, while the real row — since changed to 80 MB —
 * ends up with a per-file limit larger than the combined limit.
 *
 * Only the supplied fields are written, so two operators patching different fields do not
 * overwrite each other's changes with values read earlier.
 */
export const updateSettings = async (patch: UpdateSettingsInput): Promise<PlatformSetting> => {
  const current = await readSettings();

  const candidate = {
    maxUploadFileSizeBytes: patch.maxUploadFileSizeBytes ?? current.maxUploadFileSizeBytes,
    maxUploadFilesPerRequest: patch.maxUploadFilesPerRequest ?? current.maxUploadFilesPerRequest,
    maxUploadTotalBytes: patch.maxUploadTotalBytes ?? current.maxUploadTotalBytes,
    maxChunksPerSource: patch.maxChunksPerSource ?? current.maxChunksPerSource,
    maxChunksPerBot: patch.maxChunksPerBot ?? current.maxChunksPerBot,
    aiServiceMaxFileSizeBytes: patch.aiServiceMaxFileSizeBytes ?? current.aiServiceMaxFileSizeBytes,
  };

  const validated = settingsInvariantsSchema.safeParse(candidate);
  if (!validated.success) {
    // Surfaced as a 400 with the field-level message, so the operator is told which pair
    // of settings conflicts rather than just "invalid".
    const message = validated.error.issues.map((issue) => issue.message).join('; ');
    throw new AppError(message, 400);
  }

  const updated = await prisma.platformSetting.update({
    where: { id: 'singleton' },
    data: patch,
  });

  invalidateSettingsCache();
  return updated;
};

/**
 * Resolve the upload limits that apply to a workspace (section 12.4).
 *
 * **v1 ignores `workspaceId` and returns the platform settings.** The parameter is here
 * from day one, and the return value is a plain object rather than the Prisma row, so that
 * adding subscription tiers is a change to this function's body alone — no caller,
 * controller, or client change (section 12.10).
 *
 * Every limit read in the upload path goes through this function. Nothing else may read
 * `prisma.platformSetting`.
 */
export const resolveUploadLimits = async (workspaceId: string): Promise<EffectiveUploadLimits> => {
  // Reserved for tier resolution: workspace → tier → overrides. Referencing it here keeps
  // the parameter part of the contract rather than an artefact of the signature.
  void workspaceId;

  const settings = await getSettings();

  return {
    maxFileSizeBytes: settings.maxUploadFileSizeBytes,
    maxFilesPerRequest: settings.maxUploadFilesPerRequest,
    maxTotalBytes: settings.maxUploadTotalBytes,
    maxChunksPerSource: settings.maxChunksPerSource,
    maxChunksPerBot: settings.maxChunksPerBot,
    // From the constants, not the database: the accepted types are not operator-settable
    // in v1. They travel on the resolved object so a tier could change them later without
    // the multer factory or the `upload-limits` endpoint learning a new source.
    acceptedMimeTypes: [...ACCEPTED_MIME_TYPES],
    acceptedExtensions: [...ACCEPTED_EXTENSIONS],
  };
};
