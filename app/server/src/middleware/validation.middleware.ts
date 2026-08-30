import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { ValidationError } from '../utils/errors.js';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
}

/** Turn a ZodError into a single readable message for the API response. */
const formatZodError = (error: ZodError): string =>
  error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');

/**
 * Validation middleware (spec §5): never trust body, params, or query.
 *
 * The validated (and coerced/stripped) body replaces `req.body`. Params and query are
 * validated in place — they are string-only in our routes, so there is nothing to
 * coerce and no reason to reassign Express's request accessors.
 *
 * Any validation failure becomes a 400 ValidationError via the error middleware.
 */
export const validate =
  (schemas: ValidationSchemas): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.params) {
        schemas.params.parse(req.params);
      }
      if (schemas.query) {
        schemas.query.parse(req.query);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(new ValidationError(formatZodError(error)));
        return;
      }
      next(error);
    }
  };
