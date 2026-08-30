import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt.js';
import { AuthenticationError } from '../utils/errors.js';
import type { AuthUser } from '../types/common.types.js';

/**
 * Authentication middleware (spec §9).
 *
 * Flow: read `Authorization: Bearer <token>` -> verify JWT -> attach the minimal
 * authenticated principal to `req.user`. Any failure raises AuthenticationError,
 * which the error middleware renders as 401. Express forwards synchronous throws
 * from middleware to the error handler automatically.
 */
export const authenticate = (req: Request, _res: Response, next: NextFunction): void => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    throw new AuthenticationError('Missing or malformed Authorization header');
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    throw new AuthenticationError('Missing authentication token');
  }

  const payload = verifyToken(token);
  req.user = { id: payload.sub, email: payload.email };

  next();
};

/**
 * Type-safe accessor for the authenticated user inside controllers. Routes always run
 * `authenticate` first, so this is primarily a narrowing helper (AuthUser | undefined ->
 * AuthUser) with a defensive guard.
 */
export const getAuthUser = (req: Request): AuthUser => {
  if (!req.user) {
    throw new AuthenticationError('Authentication required');
  }
  return req.user;
};
