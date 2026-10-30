import type { Request, RequestHandler } from 'express';
import prisma from '../config/database.js';
import { verifyVisitorToken } from '../utils/jwt.js';
import { AuthenticationError, NotFoundError } from '../utils/errors.js';

/**
 * Visitor authentication for the public conversation surface
 * (HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md §10.4).
 *
 * Three things are checked, in this order, and each closes a different hole:
 *
 *   1. **Signature and shape** — `verifyVisitorToken`. A token minted for a member, or a
 *      tampered one, dies here.
 *   2. **Scope** — the token's `conversationId` must equal the id in the path. This is the
 *      claim that makes a visitor token safe to hand to a browser: a leaked token is
 *      worthless against any conversation but its own.
 *   3. **Tenancy** — the conversation is re-read and the token's `botId` and `workspaceId`
 *      must still match the row. Step 2 alone would trust the token to describe the world;
 *      this step makes the *database* the authority, so a token whose conversation moved or
 *      was deleted cannot be used to reach a different one.
 *
 * Failure semantics: anything that fails becomes **404**, matching the codebase's
 * non-member rule. A visitor who probes a foreign conversation id learns that it does not
 * exist for them, which is the same thing they learn from a genuinely absent id — so the
 * endpoint is not an existence oracle for other tenants' conversations. A *missing* token
 * is a different matter and stays 401: there is no credential at all, so there is nothing
 * to enumerate.
 */
export interface AuthenticateVisitorOptions {
  /**
   * Accept an expired token. Set by `POST /refresh` **only** (§10.3): that endpoint's input
   * is a token that has just aged out, and its real credential is the session secret in the
   * body. Never set this on a route that reads or writes conversation content.
   */
  allowExpired?: boolean;
}

export const authenticateVisitor = (
  options: AuthenticateVisitorOptions = {}
): RequestHandler => async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new AuthenticationError('Missing or malformed Authorization header');
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new AuthenticationError('Missing authentication token');
    }

    const claims = verifyVisitorToken(token, {
      ignoreExpiration: options.allowExpired ?? false,
    });

    // Scope: the token names exactly one conversation, and this must be it.
    const conversationId = req.params.conversationId;
    if (!conversationId || claims.conversationId !== conversationId) {
      throw new NotFoundError('Conversation not found');
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, botId: true, workspaceId: true, deploymentId: true },
    });

    if (!conversation) {
      throw new NotFoundError('Conversation not found');
    }

    // Tenancy: the row, not the token, decides whether this token still describes it.
    if (conversation.botId !== claims.botId || conversation.workspaceId !== claims.workspaceId) {
      throw new NotFoundError('Conversation not found');
    }

    // Deployment epoch check (Phase 3, CP-3.7):
    // If conversation was initiated through a deployment, verify deployment status and publishEpoch.
    if (conversation.deploymentId) {
      const deployment = await prisma.botDeployment.findUnique({
        where: { id: conversation.deploymentId },
        select: { status: true, enabled: true, publishEpoch: true },
      });

      if (!deployment || deployment.status === 'UNPUBLISHED') {
        throw new NotFoundError('Conversation not found');
      }

      if (claims.publishEpoch !== undefined && claims.publishEpoch !== deployment.publishEpoch) {
        throw new NotFoundError('Conversation not found');
      }
    }

    // Identity only — never lifecycle state. `status` in particular is deliberately absent:
    // it is mutable, and a handler that used it as a gate would be gating on a value that can
    // be stale before the write it guards. The chat turn reads the state itself, at the point
    // where it decides whether to call the AI (§9.2 Phase 1).
    req.visitorContext = {
      conversationId: conversation.id,
      botId: conversation.botId,
      workspaceId: conversation.workspaceId,
    };

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Type-safe accessor for the visitor context, mirroring `getAuthUser`.
 *
 * Every public route runs `authenticateVisitor` first, so this is a narrowing helper with a
 * defensive guard: if it ever fires, the route table is wrong and failing loudly is the
 * correct response.
 */
export const getVisitorContext = (req: Request): NonNullable<Request['visitorContext']> => {
  if (!req.visitorContext) {
    throw new AuthenticationError('Visitor authentication required');
  }
  return req.visitorContext;
};
