import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { JwtPayload } from '../types/common.types.js';
import { AuthenticationError } from './errors.js';

/**
 * Sign a stateless JWT for a user. `sub` holds the user id (standard claim).
 * Statelessness is intentional for Review 1 — see the logout note in auth.service.
 */
export const signToken = (payload: JwtPayload): string => {
  const options: SignOptions = {
    // env.JWT_EXPIRES_IN is validated as a string ('7d', '3600', ...); the type of
    // `expiresIn` is a narrow template-literal, so we assert the validated value.
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  };
  return jwt.sign(payload, env.JWT_SECRET, options);
};

/**
 * Verify and decode a JWT. Throws AuthenticationError on any failure (expired,
 * malformed, bad signature, or missing claims) so callers never see raw jwt errors.
 */
export const verifyToken = (token: string): JwtPayload => {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      typeof decoded.sub === 'string' &&
      typeof (decoded as Record<string, unknown>).email === 'string'
    ) {
      const raw = decoded as Record<string, unknown>;
      // platformRole is optional: tokens minted before RBAC simply lack it, and the
      // platform guard re-reads the authoritative role from the DB regardless.
      const platformRole =
        raw.platformRole === 'PLATFORM_OWNER' || raw.platformRole === 'USER'
          ? raw.platformRole
          : undefined;
      return { sub: decoded.sub, email: decoded.email as string, platformRole };
    }
    throw new AuthenticationError('Invalid authentication token');
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError('Invalid or expired authentication token');
  }
};
