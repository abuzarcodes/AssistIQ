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

// =======================================================================================
// Visitor (customer) tokens — HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md §10
//
// A second, deliberately weaker token family. The claims below are the whole security
// model: a visitor token names exactly one conversation, and `authenticateVisitor` refuses
// to let it name any other. It carries no `email`, which is also what makes it structurally
// unusable on the agent routes — `verifyToken` above requires that claim, so a visitor
// token presented to `/workspaces/*` or `/bots/*` fails there without any extra check.
// =======================================================================================

/**
 * Visitor token lifetime (§10.3).
 *
 * Short by design, and deliberately **not** configurable: the long-lived credential is the
 * 32-byte session secret in `localStorage`, and the 15-minute token exists precisely so a
 * stolen `Authorization` header ages out fast. Making this an env var would invite an
 * operator to widen the window §10.1 exists to close.
 */
const VISITOR_TOKEN_TTL = '15m';

/** The claim set of a visitor token, out of `verifyVisitorToken` (§10.4). */
export interface VisitorTokenPayload {
  sub: string;
  conversationId: string;
  botId: string;
  workspaceId: string;
  role: 'CUSTOMER';
  publishEpoch?: number;
}

/**
 * Sign a visitor token for one conversation.
 *
 * The conversation, bot and workspace are all carried so a request can be rejected by
 * comparing claims alone, without a database round-trip on the happy path — but the
 * middleware still re-reads the conversation, because a claim is only as good as the row
 * it describes and the row can move (a conversation is scoped to a bot forever, but the
 * comparison is what *proves* it rather than assumes it).
 */
export const signVisitorToken = (input: {
  conversationId: string;
  botId: string;
  workspaceId: string;
  publishEpoch?: number;
}): string =>
  jwt.sign(
    {
      sub: `visitor:${input.conversationId}`,
      conversationId: input.conversationId,
      botId: input.botId,
      workspaceId: input.workspaceId,
      role: 'CUSTOMER',
      publishEpoch: input.publishEpoch ?? 0,
    },
    env.JWT_SECRET,
    { expiresIn: VISITOR_TOKEN_TTL as SignOptions['expiresIn'] }
  );

/**
 * Verify and decode a visitor token.
 *
 * `ignoreExpiration` exists for exactly one caller — `POST /refresh` (§10.3), where an
 * *expired* token is the expected input and the session secret, not the token, is the
 * credential being checked. It is not a general-purpose escape hatch: the middleware only
 * ever sets it on that one route, and a refresh that cannot produce the matching
 * `visitorSessionHash` fails regardless of how valid the token's signature is.
 */
export const verifyVisitorToken = (
  token: string,
  options: { ignoreExpiration?: boolean } = {}
): VisitorTokenPayload => {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      ignoreExpiration: options.ignoreExpiration ?? false,
    });

    if (typeof decoded !== 'object' || decoded === null) {
      throw new AuthenticationError('Invalid visitor token');
    }

    const raw = decoded as Record<string, unknown>;

    // `role` is checked rather than assumed: without it a *member* token would satisfy the
    // shape below if it ever gained these claims, and the two token families must never be
    // interchangeable in either direction.
    if (raw.role !== 'CUSTOMER') {
      throw new AuthenticationError('Invalid visitor token');
    }
    if (
      typeof raw.conversationId !== 'string' ||
      typeof raw.botId !== 'string' ||
      typeof raw.workspaceId !== 'string'
    ) {
      throw new AuthenticationError('Invalid visitor token');
    }

    return {
      sub: `visitor:${raw.conversationId}`,
      conversationId: raw.conversationId,
      botId: raw.botId,
      workspaceId: raw.workspaceId,
      role: 'CUSTOMER',
      publishEpoch: typeof raw.publishEpoch === 'number' ? raw.publishEpoch : undefined,
    };
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError('Invalid or expired visitor token');
  }
};
