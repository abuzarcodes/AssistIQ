import type { Request, Response, NextFunction } from 'express';

/** Catch-all for unmatched routes -> standard 404 envelope (spec §16). */
export const notFoundHandler = (req: Request, res: Response, _next: NextFunction): void => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
};
