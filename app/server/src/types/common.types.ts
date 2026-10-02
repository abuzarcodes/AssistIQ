import type { PlatformRole } from '@prisma/client';

/**
 * The authenticated principal attached to `req.user` by the auth middleware.
 * Deliberately minimal — never carries the password hash or other sensitive data.
 *
 * `platformRole` is carried for convenience (client rendering, cheap checks). It is NOT
 * the authoritative source for platform authorization: `requirePlatformOwner` re-reads
 * the role from the database so a demotion takes effect immediately, not at token expiry.
 */
export interface AuthUser {
  id: string;
  email: string;
  platformRole?: PlatformRole;
}

/** Shape of the signed JWT payload. `sub` is the user id (standard JWT claim). */
export interface JwtPayload {
  sub: string;
  email: string;
  /** Optional so tokens issued before RBAC remain verifiable (they simply lack it). */
  platformRole?: PlatformRole;
}

export type { PlatformRole };
