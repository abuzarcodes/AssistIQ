import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import { isProduction } from '../config/env.js';
import { logger } from '../config/logger.js';
import { formatBytes } from '../utils/format.js';
import type { EffectiveUploadLimits } from '../types/knowledge.types.js';

interface NormalizedError {
  statusCode: number;
  message: string;
}

/** Map any thrown value to a safe { statusCode, message } pair. */
const normalize = (err: unknown, req: Request): NormalizedError => {
  if (err instanceof AppError) {
    return { statusCode: err.statusCode, message: err.message };
  }

  if (err instanceof ZodError) {
    return { statusCode: 400, message: 'Validation failed' };
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        return { statusCode: 409, message: 'A record with these details already exists' };
      case 'P2025':
        return { statusCode: 404, message: 'Resource not found' };
      case 'P2003':
        return { statusCode: 400, message: 'Invalid reference to a related resource' };
      default:
        return { statusCode: 400, message: 'Database request error' };
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    return { statusCode: 400, message: 'Invalid database query' };
  }

  // Multer upload errors (oversized/malformed multipart) are client errors, not 500s.
  // Matched by name so the error handler does not depend on multer directly.
  if (err instanceof Error && err.name === 'MulterError') {
    const code = (err as Error & { code?: string }).code;

    // The message quotes the limit that was actually applied to this request, read from
    // the resolved settings the parser was built with. A literal "10 MB" here would
    // contradict the configuration the moment an operator changed it (section 12.11).
    // When nothing was resolved — no upload route leaves it unset — the message names no
    // number rather than naming a wrong one.
    const limits: EffectiveUploadLimits | undefined = req.uploadLimits;
    // The avatar route carries no resolved workspace limits (its ceiling is a constant),
    // so it records its own byte limit for the message below.
    const limitBytes = limits?.maxFileSizeBytes ?? req.avatarMaxBytes;

    switch (code) {
      case 'LIMIT_FILE_SIZE':
        return {
          statusCode: 413,
          message: limitBytes
            ? `File too large. Maximum size is ${formatBytes(limitBytes)}.`
            : 'File too large.',
        };
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_UNEXPECTED_FILE':
        return {
          statusCode: 400,
          message: limits
            ? `Maximum ${limits.maxFilesPerRequest} files per upload.`
            : 'Too many files.',
        };
      default:
        return { statusCode: 400, message: 'Invalid file upload.' };
    }
  }

  return { statusCode: 500, message: 'Internal Server Error' };
};

/**
 * Centralized error middleware (spec §16/§17).
 *
 * Produces the standard error envelope `{ success: false, error, message }` and never
 * leaks stack traces, DB internals, or secrets. `error` is the canonical field; `message`
 * is kept as a backwards-compatible alias for existing clients. Unexpected (5xx) errors
 * are logged at error level; expected client errors (4xx) are logged at debug to avoid
 * noise.
 */
export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  // next is required for Express to recognize this as an error handler.
  _next: NextFunction
): void => {
  const { statusCode, message } = normalize(err, req);

  if (statusCode >= 500) {
    logger.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled server error');
  } else {
    logger.debug({ method: req.method, url: req.originalUrl, statusCode, message }, 'Request error');
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    message,
    // Structured detail, when the thrower supplied any — the all-files-rejected batch
    // response carries its per-file reasons here (§12.6). Named `data` so the error body
    // and the success body put their payload under the same key.
    ...(err instanceof AppError && err.details !== undefined ? { data: err.details } : {}),
    // Stack is only ever exposed outside production, and only for genuine errors.
    ...(!isProduction && err instanceof Error ? { stack: err.stack } : {}),
  });
};
