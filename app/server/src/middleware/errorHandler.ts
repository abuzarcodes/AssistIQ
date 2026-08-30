import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors.js';
import { isProduction } from '../config/env.js';
import { logger } from '../config/logger.js';

interface NormalizedError {
  statusCode: number;
  message: string;
}

/** Map any thrown value to a safe { statusCode, message } pair. */
const normalize = (err: unknown): NormalizedError => {
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

  return { statusCode: 500, message: 'Internal Server Error' };
};

/**
 * Centralized error middleware (spec §16/§17).
 *
 * Produces the standard error envelope `{ success: false, message }` and never leaks
 * stack traces, DB internals, or secrets. Unexpected (5xx) errors are logged at error
 * level; expected client errors (4xx) are logged at debug to avoid noise.
 */
export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  // next is required for Express to recognize this as an error handler.
  _next: NextFunction
): void => {
  const { statusCode, message } = normalize(err);

  if (statusCode >= 500) {
    logger.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled server error');
  } else {
    logger.debug({ method: req.method, url: req.originalUrl, statusCode, message }, 'Request error');
  }

  res.status(statusCode).json({
    success: false,
    message,
    // Stack is only ever exposed outside production, and only for genuine errors.
    ...(!isProduction && err instanceof Error ? { stack: err.stack } : {}),
  });
};
