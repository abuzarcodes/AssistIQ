import type { Response } from 'express';

/**
 * Standard success envelope used by every controller (spec §16):
 *   { success: true, message, data }
 *
 * Error responses are produced exclusively by the error middleware, so controllers
 * only ever need this helper for the happy path.
 */
export const sendSuccess = <T>(
  res: Response,
  data: T,
  message = 'Operation successful',
  statusCode = 200
): void => {
  res.status(statusCode).json({
    success: true,
    message,
    data,
  });
};
