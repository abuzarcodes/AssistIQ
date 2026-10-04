import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import { AppError } from '../utils/errors.js';
import { resolveUploadLimits } from '../services/platformSettings.service.js';
import {
  ACCEPTED_AVATAR_LABEL,
  ACCEPTED_AVATAR_MIME_TYPES,
  MAX_AVATAR_BYTES,
} from '../constants/uploads.js';

/**
 * Upload limit resolution and per-request multer construction (section 12.5).
 *
 * Route order is load-bearing:
 *
 * ```
 * authenticate
 *   → validate(params)
 *   → requireWorkspacePermission(DOCUMENTS_MANAGE, { from: 'bot' })  ← BEFORE multer
 *   → uploadLimits()          ← resolves onto req.uploadLimits
 *   → documentUpload('files', N)   ← multer built from those limits
 *   → handler
 * ```
 *
 * **The permission guard must run first.** Multer buffers the entire body into memory as
 * it parses, so a guard placed after it lets an unauthorized caller make the server
 * allocate the file before being refused — with batch upload that is a memory
 * amplification vector, not just wasted work.
 *
 * **Multer must be built per request.** `limits.fileSize` is fixed when the instance is
 * created, so a module-level instance cannot honour a runtime-tweaked setting. Constructing
 * one per request is cheap (a thin wrapper over busboy) and keeps the database the single
 * source of truth.
 */

/**
 * Resolve the effective limits onto the request.
 *
 * Reads the workspace id from `req.workspaceContext`, which the permission middleware sets.
 * Absent context is a **middleware-order bug**, not a client error, so it is a 500: the
 * alternative — silently falling back to defaults — would enforce limits the platform
 * owner did not configure and hide the ordering mistake at the same time.
 */
export const uploadLimits = (): RequestHandler => async (req, _res, next) => {
  try {
    const workspaceId = req.workspaceContext?.workspaceId;

    if (!workspaceId) {
      throw new AppError(
        'Upload limits cannot be resolved: the workspace was not established on this request.',
        500
      );
    }

    req.uploadLimits = await resolveUploadLimits(workspaceId);
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Build the multipart parser for an upload route from the resolved limits.
 *
 * `field` is the multipart field name. `mode` selects between one file (`single`, stored on
 * `req.file`) and a batch (`array`, stored on `req.files`, capped at the operator's
 * configured files-per-request). The batch cap cannot be a literal — it is a runtime
 * setting, so it is read from the request's resolved limits at build time.
 *
 * **The type filter is mode-dependent, and that is deliberate.** A multer `fileFilter` that
 * rejects a wrong MIME type does so by aborting the *whole request* — which is exactly right
 * for the legacy single-file route (one file, one outcome) and exactly wrong for a batch:
 * §12.6 requires 2 valid + 1 wrong-type to return **201** with `processed = 2`,
 * `rejected = 1`. So the batch parser accepts every type and
 * `knowledgeSourceService.validateFile` decides per file, which is the only place a
 * rejection can be attributed to one file. Memory stays bounded either way — `limits.files`
 * and `limits.fileSize` cap what the parser will buffer, whatever the content type.
 *
 * **The size ceiling is mode-dependent for the same reason.** Multer's `fileSize` aborts
 * the whole request with `LIMIT_FILE_SIZE`, so on the batch route it cannot be the
 * operator's per-file limit: §12.6 requires an oversized file to be a per-file `REJECTED`
 * with its siblings still processed, and states plainly that such a request "is **not** a
 * 413". The batch parser therefore uses the whole-request total as its heap guard — the
 * request cannot legitimately exceed that, so nothing smaller is needed — and the
 * operator's per-file limit is enforced per file by `validateFile`. The invariant
 * `maxUploadTotalBytes >= maxUploadFileSizeBytes` in `platformSettings.schema.ts`
 * guarantees the guard is never below the per-file limit, so a file the operator allows is
 * never refused by the parser.
 *
 * The AI service's own file-size ceiling is deliberately *not* part of this guard. It is
 * an internal backstop enforced at the AI boundary (a file it refuses becomes a per-file
 * `FAILED`), not a limit this tier advertises; folding it in here would also mean putting
 * it on `EffectiveUploadLimits`, which is serialized straight to clients by
 * `GET /upload-limits`. The invariant `aiServiceMaxFileSizeBytes >= maxUploadFileSizeBytes`
 * is what keeps the two from contradicting each other.
 */
export const documentUpload = (field: string, mode: 'single' | 'batch'): RequestHandler => {
  /** Build the parser for this request, from this request's resolved limits. */
  const build = (req: Request): RequestHandler => {
    const limits = req.uploadLimits;

    if (!limits) {
      // Same reasoning as `uploadLimits()`: reaching multer without resolved limits means
      // the chain was assembled wrongly, so fail loudly rather than parse with a guess.
      throw new AppError(
        'Upload limits were not resolved before the body parser ran.',
        500
      );
    }

    // `single` enforces the resolved per-file limit directly — one file, so refusing the
    // request IS the right answer, and a 413 quoting it is the documented behaviour.
    // `batch` uses the heap guard described above, because a request-level failure there
    // would discard the work already done on the batch's other files.
    const fileSizeLimit =
      mode === 'single' ? limits.maxFileSizeBytes : limits.maxTotalBytes;

    const instance = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: fileSizeLimit,
        // Counts only files multer accepted, and the handler re-checks the total
        // independently — `limits.files` does not bound combined bytes. For the batch,
        // `array`'s own cap is the same number, so whichever fires first produces the
        // same "Maximum N files per upload" message.
        files: mode === 'single' ? 1 : limits.maxFilesPerRequest,
        // Bound the non-file parts of the multipart body too, or a request can carry an
        // arbitrary number of text fields.
        fields: 10,
        parts: limits.maxFilesPerRequest + 10,
      },
      // See this function's docstring: the strict filter is for `single` only.
      fileFilter:
        mode === 'single'
          ? (_req, file, cb) => {
              if (limits.acceptedMimeTypes.includes(file.mimetype)) {
                cb(null, true);
              } else {
                cb(new AppError('Only PDF and DOCX files are allowed.', 400));
              }
            }
          : (_req, _file, cb) => cb(null, true),
    });

    // `single` stores into `req.file` and `array` into `req.files`; the handler for each
    // route reads the one its own parser produced.
    return mode === 'single'
      ? instance.single(field)
      : instance.array(field, limits.maxFilesPerRequest);
  };

  // Building the parser inside the returned handler is what makes it per-request: the
  // limits are only known once `uploadLimits()` has run.
  return (req, res, next) => {
    try {
      build(req)(req, res, next);
    } catch (err) {
      next(err);
    }
  };
};

/**
 * The multipart parser for a bot avatar upload (§10.2).
 *
 * Built once at module load, unlike `documentUpload`, because its limits are **constants**
 * rather than a resolved per-workspace setting — there is nothing request-specific to read,
 * so there is nothing to rebuild per request.
 *
 * **Route order is still load-bearing: permission before this.** The reason is the one
 * documented at the top of this file — multer buffers the whole body into memory as it
 * parses, so a guard placed after it lets an unauthorized caller make the server allocate
 * half a megabyte before being refused. The `fileSize` cap bounds the damage; it does not
 * make the ordering optional.
 *
 * The filter is a *claim* check, not a content check: `file.mimetype` is whatever the client
 * put in the `Content-Type` of the part, so it is untrusted. `avatar.service.ts` re-checks
 * the actual bytes and stores the type it sniffed rather than the type it was told.
 */
export const avatarUpload = (field: string): RequestHandler => {
  const instance = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_AVATAR_BYTES,
      // One image per bot, so anything beyond the first file is a malformed request rather
      // than a batch to be trimmed. `fields: 0` reflects that this route takes no text
      // parts at all — an avatar is the entire body.
      //
      // **No `parts` limit.** Its only effect here would be to reject a well-formed
      // single-file upload: busboy counts the file part and trips `LIMIT_PART_COUNT` at
      // `parts: 1` before the file is seen, so a limit of 1 refuses everything and a limit
      // of 2 is the number that means "one". `files: 1` and `fields: 0` already state the
      // real rule exactly, and each maps to its own 400 in `errorHandler`, so `parts` would
      // add a number to maintain and a way to silently break every avatar upload.
      files: 1,
      fields: 0,
    },
    fileFilter: (_req, file, cb) => {
      if (ACCEPTED_AVATAR_MIME_TYPES.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new AppError(`Only ${ACCEPTED_AVATAR_LABEL} images are allowed.`, 400));
      }
    },
  });

  const parser = instance.single(field);

  // Record the ceiling so the shared multer error mapping can name it in a 413. Set before
  // parsing rather than after, because an oversized request never reaches the handler.
  return (req, res, next) => {
    req.avatarMaxBytes = MAX_AVATAR_BYTES;
    parser(req, res, next);
  };
};
