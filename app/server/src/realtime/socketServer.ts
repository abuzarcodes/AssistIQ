import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import prisma from '../config/database.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { hasWorkspacePermission } from '../services/authorization.service.js';
import { getSocketServer, parseRoom, setSocketServer, userRoom } from './events.js';
import { authenticateHandshake, type SocketPrincipal } from './socketAuth.js';

/**
 * Socket.IO transport and authorized room joins
 * (HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md §15.2, §16.1, §20).
 *
 * Two design decisions carry the security weight here.
 *
 * **Rooms are joined explicitly, never implicitly.** A visitor socket does not auto-join its
 * own conversation on connect. Every subscription goes through the same `room:join` handler,
 * so there is exactly one place where access is decided, and a test that proves the handler
 * denies a foreign room proves it for every subscriber. An auto-join would be a second,
 * differently-shaped path that the denial test does not cover.
 *
 * **Authority is re-derived from the database per join, never from the token.** The token
 * establishes *who* is asking (§15.2); whether they may watch a given queue is answered by
 * live membership, exactly as the HTTP middleware answers it. A token minted before a member
 * was removed still authenticates — that is what `evictWorkspaceMember` is for — but it can
 * never join a room the caller is no longer entitled to.
 */

/** The acknowledgement a client receives for `room:join`. */
export interface JoinAck {
  ok: boolean;
  error?: string;
  room?: string;
}

/** Per-socket bookkeeping: which room belongs to which workspace, for eviction (§20). */
interface SocketSubscriptions {
  principal: SocketPrincipal;
  /** room name → workspace id. Only workspace-scoped rooms are recorded. */
  rooms: Map<string, string>;
}

declare module 'socket.io' {
  interface SocketData {
    subscriptions: SocketSubscriptions;
  }
}

/**
 * Reject reasons are coarse on purpose.
 *
 * A caller who is not a member of a workspace and a caller asking for a workspace that does
 * not exist get the same answer, mirroring the HTTP layer's 404-not-403 rule (§8): a distinct
 * "you are not a member" would confirm the workspace is real to someone with no right to know.
 */
const DENIED = 'FORBIDDEN';

/**
 * Decide whether this socket may subscribe to `room`.
 *
 * Returns the workspace id the room belongs to, so the caller can record it for eviction.
 */
const authorizeRoomJoin = async (
  principal: SocketPrincipal,
  room: string
): Promise<{ ok: true; workspaceId: string } | { ok: false }> => {
  const parsed = parseRoom(room);
  if (!parsed) {
    // Includes the private `user:` room and every malformed name. There is no fallthrough:
    // an unrecognized room is not a room this server knows how to authorize.
    return { ok: false };
  }

  if (parsed.kind === 'workspace-queue') {
    // Visitors never see a queue — `kind` is checked before any database access, so a visitor
    // token cannot be used to probe workspace existence through a timed response.
    if (principal.kind !== 'agent') return { ok: false };

    const allowed = await hasWorkspacePermission(
      principal.userId,
      parsed.workspaceId,
      PERMISSIONS.CONVERSATIONS_VIEW
    );
    return allowed ? { ok: true, workspaceId: parsed.workspaceId } : { ok: false };
  }

  if (principal.kind === 'visitor') {
    // A visitor token names exactly one conversation (§10.4). Comparison against the claim is
    // the authorization: the visitor cannot reach another conversation's transcript, and the
    // conversation id in the request is not treated as evidence of anything.
    return parsed.conversationId === principal.conversationId
      ? { ok: true, workspaceId: principal.workspaceId }
      : { ok: false };
  }

  // An agent may watch a conversation that belongs to a workspace they hold CONVERSATIONS_VIEW
  // in. Read from the conversation rather than trusted from the client, so the workspace is
  // the row's own and not a claim the caller supplied.
  const conversation = await prisma.conversation.findUnique({
    where: { id: parsed.conversationId },
    select: { workspaceId: true },
  });
  if (!conversation) return { ok: false };

  const allowed = await hasWorkspacePermission(
    principal.userId,
    conversation.workspaceId,
    PERMISSIONS.CONVERSATIONS_VIEW
  );
  return allowed ? { ok: true, workspaceId: conversation.workspaceId } : { ok: false };
};

/**
 * Attach Socket.IO to an existing HTTP server and register it for post-commit emissions.
 *
 * Takes the server rather than creating one, so the realtime transport and the REST API share
 * a single port and a single lifecycle — `server.ts` owns both, and shutdown closes both.
 */
export const attachSocketServer = (httpServer: HttpServer): SocketServer => {
  const io = new SocketServer(httpServer, {
    // Mirrors the HTTP CORS policy in `app.ts`. Credentials are enabled only for an explicit
    // origin list: a wildcard with credentials is rejected by browsers, and the socket
    // credential travels in the handshake payload rather than a cookie, so the `*` mode is
    // not merely broken there — nothing needs it.
    cors:
      env.CORS_ORIGIN === '*'
        ? { origin: '*', credentials: false }
        : { origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()), credentials: true },
  });

  // Handshake gate. A middleware error surfaces to the client as `connect_error` and the
  // connection never completes, so an unauthenticated socket has no event handlers to reach.
  io.use((socket, next) => {
    try {
      const principal = authenticateHandshake(socket.handshake);
      socket.data.subscriptions = { principal, rooms: new Map() };
      // The private room exists only so `evictWorkspaceMember` can address this user's
      // sockets later. Nothing is emitted to it and joining it grants no read access.
      if (principal.kind === 'agent') {
        void socket.join(userRoom(principal.userId));
      }
      next();
    } catch (error) {
      logger.warn({ err: error }, 'Rejected socket handshake');
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const { principal } = socket.data.subscriptions;
    logger.debug({ principal: principal.kind }, 'Socket connected');

    socket.on('room:join', async (payload: unknown, ack?: (response: JoinAck) => void) => {
      const room = (payload as { room?: unknown } | null)?.room;

      const respond = (response: JoinAck): void => {
        if (typeof ack === 'function') ack(response);
      };

      if (typeof room !== 'string') {
        respond({ ok: false, error: 'INVALID_ROOM' });
        return;
      }

      let decision: { ok: true; workspaceId: string } | { ok: false };
      try {
        decision = await authorizeRoomJoin(principal, room);
      } catch (error) {
        // A database failure is not an authorization decision, and answering "denied" would
        // be indistinguishable from a real denial. Report the failure as itself.
        logger.error({ err: error, room }, 'Room join authorization failed');
        respond({ ok: false, error: 'INTERNAL_ERROR' });
        return;
      }

      if (!decision.ok) {
        logger.warn({ room, principal: principal.kind }, 'Rejected room join');
        respond({ ok: false, error: DENIED });
        return;
      }

      await socket.join(room);
      socket.data.subscriptions.rooms.set(room, decision.workspaceId);
      respond({ ok: true, room });
    });

    socket.on('room:leave', async (payload: unknown, ack?: (response: JoinAck) => void) => {
      const room = (payload as { room?: unknown } | null)?.room;
      if (typeof room !== 'string') {
        if (typeof ack === 'function') ack({ ok: false, error: 'INVALID_ROOM' });
        return;
      }

      // Leaving is always permitted: it only ever reduces access.
      await socket.leave(room);
      socket.data.subscriptions.rooms.delete(room);
      if (typeof ack === 'function') ack({ ok: true, room });
    });

    socket.on('disconnect', (reason) => {
      logger.debug({ reason }, 'Socket disconnected');
    });
  });

  setSocketServer(io);
  logger.info('Socket.IO attached');
  return io;
};

/**
 * Evict a removed member's sockets from a workspace (§20, "Revoked Member Socket Disconnect").
 *
 * Called by `workspaceMember.service.removeMember` **after** its transaction commits — the
 * eviction is a reaction to a completed membership change, not part of it. Ordering matters in
 * the other direction too: were the socket to keep its subscription through the commit, the
 * member would keep receiving `message:new` for customer messages in a workspace they were
 * just removed from, which is the exact disclosure the eviction prevents.
 *
 * The socket is disconnected rather than merely unsubscribed. It authenticated with a token
 * that still says `userId`, and its `socket.data` still holds that identity; leaving it
 * connected invites it to re-join a room the authorization no longer grants, which is a
 * denial that depends on the authorizer staying correct. Disconnecting makes the revocation
 * total: the client must present a new token, and the new token is checked against a
 * membership that no longer includes this workspace.
 *
 * A user who is still a member of *other* workspaces reconnects and re-joins them. That is a
 * deliberate trade in favour of the revocation being unconditional.
 */
export const evictWorkspaceMember = async (
  userId: string,
  workspaceId: string
): Promise<number> => {
  const io = getSocketServer();
  if (!io) return 0;

  const sockets = await io.in(userRoom(userId)).fetchSockets();
  let evicted = 0;

  for (const socket of sockets) {
    const subscriptions = (socket.data as { subscriptions?: SocketSubscriptions }).subscriptions;
    if (!subscriptions) continue;

    const revokedRooms = [...subscriptions.rooms.entries()]
      .filter(([, roomWorkspaceId]) => roomWorkspaceId === workspaceId)
      .map(([room]) => room);

    if (revokedRooms.length === 0) continue;

    for (const room of revokedRooms) {
      await socket.leave(room);
      subscriptions.rooms.delete(room);
    }

    socket.disconnect(true);
    evicted += 1;
  }

  if (evicted > 0) {
    logger.info({ userId, workspaceId, evicted }, 'Evicted revoked member sockets');
  }

  return evicted;
};

/**
 * Evict all visitor sockets connected to conversations of a specific bot (Phase 3, CP-3.8).
 * Called by `unpublishExperience` after status change commits, disconnecting active customer sessions.
 */
export const evictBotVisitorSockets = async (botId: string): Promise<number> => {
  const io = getSocketServer();
  if (!io) return 0;

  const sockets = await io.fetchSockets();
  let evicted = 0;

  for (const socket of sockets) {
    const subscriptions = (socket.data as { subscriptions?: SocketSubscriptions }).subscriptions;
    if (!subscriptions) continue;

    if (subscriptions.principal.kind === 'visitor' && subscriptions.principal.botId === botId) {
      for (const room of subscriptions.rooms.keys()) {
        await socket.leave(room);
      }
      subscriptions.rooms.clear();
      socket.disconnect(true);
      evicted += 1;
    }
  }

  if (evicted > 0) {
    logger.info({ botId, evicted }, 'Evicted bot visitor sockets on unpublish');
  }

  return evicted;
};

/**
 * Detach the server when the HTTP server closes.
 *
 * Without this, an in-process test that attaches, exercises, and closes a realtime listener
 * would leave the registry pointing at a dead server, and a later service call would emit into
 * it — a broadcast with no transport behind it, which fails silently in exactly the way this
 * module's `emitToRoom` guard exists to prevent at the other end.
 */
export const detachSocketServer = (io: SocketServer): void => {
  if (getSocketServer() === io) {
    setSocketServer(null);
    logger.info('Socket.IO detached');
  }
};
