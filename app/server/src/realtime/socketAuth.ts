import type { IncomingHttpHeaders } from 'node:http';
import { verifyToken, verifyVisitorToken } from '../utils/jwt.js';
import { AuthenticationError } from '../utils/errors.js';

/**
 * Socket handshake authentication
 * (HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md §15.2, §20).
 *
 * The socket layer speaks both token families, and the distinction is the entire authorization
 * model downstream: a visitor principal is scoped to exactly one conversation and may only
 * ever watch it, while a member principal may join the queues of workspaces they belong to.
 * `SocketPrincipal.kind` makes that a total, checked property rather than a convention.
 *
 * **Deviation from the plan text, recorded deliberately.** §15.2 sketches the middleware as
 * `verifyToken(token)` followed by `payload.role === 'CUSTOMER'`. That cannot work: `verifyToken`
 * rejects any token without an `email` claim, which visitor tokens never carry (§10.4), and
 * `JwtPayload` has no `role` field at all — so the sketch would 401 every visitor and the
 * `CUSTOMER` branch would be unreachable. This module implements the *intent*: try the visitor
 * family first (it is the structurally tighter check — it demands `role`, `conversationId`,
 * `botId` and `workspaceId`), then fall back to the member family.
 *
 * Neither verification is weakened to make this work. In particular, `verifyVisitorToken` is
 * called **without** `ignoreExpiration`: §10.3 grants that exception to `POST /refresh` alone,
 * where the session secret is the real credential. A socket has no such second factor, so an
 * expired visitor token cannot hold a subscription open — the client must refresh and reconnect.
 */

/** A customer, holding a token scoped to one conversation (§10.4). Read-only, one room. */
export interface VisitorSocketPrincipal {
  kind: 'visitor';
  conversationId: string;
  botId: string;
  workspaceId: string;
}

/** A workspace member. Room joins are still authorized per room, against live membership. */
export interface AgentSocketPrincipal {
  kind: 'agent';
  userId: string;
  email: string;
}

export type SocketPrincipal = VisitorSocketPrincipal | AgentSocketPrincipal;

/** The handshake surface this module reads, narrowed so tests can supply a plain object. */
export interface HandshakeInput {
  auth?: { token?: unknown } | undefined;
  headers: IncomingHttpHeaders;
}

/**
 * Pull the bearer token from the handshake.
 *
 * `auth.token` first because that is the Socket.IO idiom and keeps the credential out of
 * URLs; the `Authorization` header is accepted so a client can reuse the exact header it
 * already sends on REST calls.
 */
const extractToken = (handshake: HandshakeInput): string | null => {
  const fromAuth = handshake.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) {
    return fromAuth;
  }

  const header = handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }

  return null;
};

/**
 * Resolve a handshake to a principal, or throw `AuthenticationError`.
 *
 * Throwing is the contract: `socketServer` registers this as `io.use(...)` middleware, and
 * Socket.IO turns a middleware error into a `connect_error` on the client — the connection is
 * refused before any event handler exists, so an unauthenticated socket has no surface to act
 * on. §20's "unauthenticated socket rejected" is that refusal, not a post-connect kick.
 */
export const authenticateHandshake = (handshake: HandshakeInput): SocketPrincipal => {
  const token = extractToken(handshake);

  if (!token) {
    throw new AuthenticationError('Authentication token required');
  }

  try {
    const visitor = verifyVisitorToken(token);
    return {
      kind: 'visitor',
      conversationId: visitor.conversationId,
      botId: visitor.botId,
      workspaceId: visitor.workspaceId,
    };
  } catch {
    // Not a visitor token — expected for every agent connection. Fall through rather than
    // reporting, so the member attempt below produces the error message the client sees.
  }

  try {
    const member = verifyToken(token);
    return { kind: 'agent', userId: member.sub, email: member.email };
  } catch {
    // Deliberately one error for both families: distinguishing "expired visitor token" from
    // "not a token at all" tells an unauthenticated caller which family they are holding.
    throw new AuthenticationError('Invalid or expired authentication token');
  }
};
