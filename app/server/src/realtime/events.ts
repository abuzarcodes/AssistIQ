import type { Server } from 'socket.io';
import type { ConversationStatus, MessageRole } from '@prisma/client';
import { logger } from '../config/logger.js';

/**
 * Realtime event vocabulary and post-commit emit helpers
 * (HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md §12.2, §15.2, §16.1).
 *
 * Two rules shape this file.
 *
 * **1. Emission is not a side effect of persistence; it is a notification about it.** Every
 * helper here is called by a service *after* its transaction has committed, never inside the
 * callback. A client that reacts to an event by reading the resource back (§15.3's recovery
 * path is one such client) must find the committed row, and an emit from inside a transaction
 * would race exactly that read.
 *
 * **2. The absence of a socket server is a normal state, not an error.** The HTTP API is
 * complete without realtime: every route these events describe has a REST equivalent, and the
 * cursor endpoint exists precisely so a client that missed an event can catch up. Nine of the
 * existing test suites drive the app through supertest with no Socket.IO server attached, and
 * they exercise the same emit call sites. So the registry below is allowed to be empty and
 * every helper degrades to a no-op rather than throwing.
 */

// =======================================================================================
// Rooms (§15.2)
//
// Room names are built here rather than at the call sites because the *shape* of a room name
// is a security boundary: `socketServer` authorizes a join by parsing this string, so a room
// name assembled ad hoc somewhere else is a room the authorizer may not recognize — and an
// unrecognized room must be rejected rather than defaulted into access.
// =======================================================================================

/** Every agent in a workspace who may see the queue. Requires membership + `CONVERSATIONS_VIEW`. */
export const workspaceQueueRoom = (workspaceId: string): string =>
  `workspace:${workspaceId}:queue`;

/** One conversation's transcript. Joined by the owning visitor, or by a member of its workspace. */
export const conversationRoom = (conversationId: string): string =>
  `conversation:${conversationId}`;

/**
 * A member's own private room, used only to address their sockets for eviction (§20).
 *
 * Not a subscription: nothing is ever emitted here, and joining it grants no read access. It
 * exists so `evictWorkspaceMember` can reach the sockets belonging to one user without
 * scanning every connected socket.
 */
export const userRoom = (userId: string): string => `user:${userId}`;

/** A parsed room name, or `null` when the string is not one of the two subscribable shapes. */
export type ParsedRoom =
  | { kind: 'workspace-queue'; workspaceId: string }
  | { kind: 'conversation'; conversationId: string };

/**
 * Parse a client-supplied room name (§15.2).
 *
 * Returns `null` for anything unrecognized — including the private `user:` room, which is
 * joined by the server and never by a client. The caller rejects `null` outright; there is no
 * "unknown room, allow by default" branch, because the only thing an unrecognized name can be
 * is an attempt to reach a room the authorizer has no rule for.
 */
export const parseRoom = (room: unknown): ParsedRoom | null => {
  if (typeof room !== 'string') return null;

  const workspaceMatch = /^workspace:([0-9a-fA-F-]{36}):queue$/.exec(room);
  if (workspaceMatch) return { kind: 'workspace-queue', workspaceId: workspaceMatch[1] };

  const conversationMatch = /^conversation:([0-9a-fA-F-]{36})$/.exec(room);
  if (conversationMatch) return { kind: 'conversation', conversationId: conversationMatch[1] };

  return null;
};

// =======================================================================================
// Payloads
// =======================================================================================

/**
 * A message as delivered over the wire (§15.3.3).
 *
 * `senderId` is optional and present only on the staff-facing copy. The visitor transcript
 * deliberately hides it (§18.2 — internal staff identity is not customer-visible), and the
 * conversation room is read by the visitor, so the copy sent there omits it. Staff receive
 * the full record through the workspace queue room instead. See `emitMessageCreated`.
 */
export interface RealtimeMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  clientMessageId: string | null;
  createdAt: string;
  senderId?: string | null;
}

/** The source row `emitMessageCreated` projects from. */
export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: Date;
  clientMessageId?: string | null;
  senderId?: string | null;
}

/** Lifecycle notification (§14). Carries the resulting state so a client can update without a refetch. */
export interface RealtimeConversationEvent {
  conversationId: string;
  status: ConversationStatus;
  assignedAgentId: string | null;
  version?: number;
  /** Who caused the transition, when the audit trail records one. */
  actorId?: string | null;
  occurredAt: string;
}

/** The escalation notification (§16.1), carrying the reason the customer entered the queue. */
export interface RealtimeEscalation extends RealtimeConversationEvent {
  escalatedAt: string;
  escalationReason: string | null;
  escalatedOffHours: boolean;
}

/** The queue-changed nudge (§16.1 — "live count badges dynamically updated on `queue:updated`"). */
export interface RealtimeQueueUpdate {
  workspaceId: string;
  conversationId: string;
  status: ConversationStatus;
}

// =======================================================================================
// The server registry
// =======================================================================================

let socketServer: Server | null = null;

/**
 * Publish the attached server. Called once by `socketServer.ts`; `null` detaches.
 *
 * Detaching matters: an in-process test that starts and stops a realtime listener must not
 * leave a dangling server that a later service call would emit into.
 */
export const setSocketServer = (server: Server | null): void => {
  socketServer = server;
};

/** The attached server, or `null` in HTTP-only mode. */
export const getSocketServer = (): Server | null => socketServer;

/**
 * Emit to one room, tolerating an unattached server.
 *
 * A failure to notify must never fail the request that caused it: the data is already
 * committed and reachable over REST, so a broadcast problem is a degraded-realtime incident,
 * not a failed message. It is logged rather than swallowed silently, because a realtime layer
 * that is quietly dead looks exactly like a client that is ignoring its events.
 */
const emitToRoom = (room: string, event: string, payload: unknown): void => {
  if (!socketServer) return;

  try {
    socketServer.to(room).emit(event, payload);
  } catch (error) {
    logger.error({ err: error, room, event }, 'Failed to emit realtime event');
  }
};

// =======================================================================================
// Emit helpers — all post-commit
// =======================================================================================

/**
 * Announce a newly committed message (§15.3.3).
 *
 * Two copies, because the two rooms have different least-privileged readers:
 *
 * - `conversation:<id>` carries the visitor-safe projection, without `senderId`. The visitor
 *   is a member of this room, so anything sent here is customer-visible.
 * - `workspace:<id>:queue` carries the full record, staff identity included.
 *
 * An agent subscribed to both — which the CP5 inbox is — receives the message twice. That is
 * intentional and harmless: both copies share `id` and `clientMessageId`, which is the same
 * pair §15.3.3 already requires clients to dedupe on for the recovery path.
 */
export const emitMessageCreated = (workspaceId: string, message: MessageRecord): void => {
  const base = {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    clientMessageId: message.clientMessageId ?? null,
    createdAt: message.createdAt.toISOString(),
  };

  emitToRoom(conversationRoom(message.conversationId), 'message:new', base);
  emitToRoom(workspaceQueueRoom(workspaceId), 'message:new', {
    ...base,
    senderId: message.senderId ?? null,
  } satisfies RealtimeMessage);
};

/**
 * Announce a lifecycle transition under its own event name (§14, §15.3.1).
 *
 * Sent to both rooms for the same reason `emitMessageCreated` sends two copies: the visitor
 * is watching for `conversation:escalated` to learn that a human is coming, and agents are
 * watching for `conversation:claimed` to drop the ticket from their shared queue.
 *
 * `actorId` is forwarded to the workspace room only. It is an internal user id, and the
 * visitor has no use for it — the visitor-safe transcript projection (§10.5) omits it for the
 * same reason.
 */
export const emitConversationEvent = (
  workspaceId: string,
  event:
    | 'conversation:escalated'
    | 'conversation:claimed'
    | 'conversation:assigned'
    | 'conversation:unassigned'
    | 'conversation:resolved'
    | 'conversation:reopened',
  /**
   * A union rather than just the base: `conversation:escalated` carries the escalation facts
   * (`escalatedAt`, `escalationReason`, `escalatedOffHours`) that the other five have no
   * meaning for, and typing it as the base would reject the one payload that needs them.
   */
  payload: RealtimeConversationEvent | RealtimeEscalation
): void => {
  const { actorId, ...visitorSafe } = payload;

  emitToRoom(conversationRoom(payload.conversationId), event, visitorSafe);
  emitToRoom(workspaceQueueRoom(workspaceId), event, { ...payload, actorId: actorId ?? null });
};

/**
 * Nudge every agent's queue view in a workspace (§16.1).
 *
 * Emitted whenever a change could alter the queue's *composition or order* — a message
 * moving a ticket to the top of the assigned list, an escalation adding a row, a claim
 * removing one. The payload names what changed so a client can render a badge immediately,
 * but it is deliberately not a diff: clients refetch, because the queue's order depends on
 * state (which tickets are assigned to whom) that a single row cannot express.
 */
export const emitQueueUpdated = (
  workspaceId: string,
  update: Omit<RealtimeQueueUpdate, 'workspaceId'>
): void => {
  emitToRoom(workspaceQueueRoom(workspaceId), 'queue:updated', {
    workspaceId,
    ...update,
  } satisfies RealtimeQueueUpdate);
};
