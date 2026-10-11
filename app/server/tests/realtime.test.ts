import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createServer, type Server as HttpServer } from 'node:http';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { config as loadEnv } from 'dotenv';

/**
 * CP4 verification: the realtime transport, the authorization of every room subscription, and
 * the recovery path a client uses when it missed a notification.
 *
 * The whole file runs against a **real Socket.IO server on a real HTTP server speaking to real
 * PostgreSQL**, with only `aiServiceClient.chat` mocked. That is the only arrangement that can
 * show what this checkpoint claims. A socket layer is exactly the kind of code where a mock
 * proves nothing: the subject is whether bytes actually reach one client and not another, and
 * a mocked transport would only show that the test's own stub was called.
 *
 * The server is built the way `src/server.ts` builds it — `createServer(app)` with Socket.IO
 * attached — rather than by calling `attachSocketServer` on a bare server with no routes. The
 * emissions under test are triggered by real HTTP requests that go through routing, RBAC and
 * the service layer, so anything less would be testing a different server than production.
 *
 * Two consequences of running for real are handled explicitly:
 *
 * - **The rate limiters are real and stateful.** `POST /public/bots/:botId/conversations` is
 *   IP-limited to 10/min with a module-level store, so this suite never calls it: conversations
 *   are seeded directly and their tokens minted with the production `signVisitorToken`. Each
 *   test also mints a *fresh* visitor token, which is what gives it its own 30/min messaging
 *   bucket (§18.4) instead of sharing one with the rest of the file.
 * - **Emission is asynchronous relative to the HTTP response.** Every assertion on a delivered
 *   event is therefore an `await` on the socket, never a sleep followed by a guess.
 */

const aiMock = vi.hoisted(() => ({ chat: vi.fn() }));

vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

loadEnv({ path: new URL('../.env', import.meta.url), override: true });
process.env.LOG_LEVEL = 'silent';

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

if (!reachable) {
  console.warn(
    '[realtime] PostgreSQL is not reachable — skipping live realtime verification. ' +
      'Set DATABASE_URL in app/server/.env to run these tests.'
  );
}

const { default: app } = await import('../src/app.js');
const { attachSocketServer, detachSocketServer } = await import('../src/realtime/socketServer.js');
const { workspaceQueueRoom, conversationRoom } = await import('../src/realtime/events.js');
const { signToken, signVisitorToken } = await import('../src/utils/jwt.js');

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

let createdWorkspaceIds: string[] = [];
let createdUserIds: string[] = [];

const unique = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const makeUser = async (label: string) => {
  const user = await prisma.user.create({
    data: {
      name: `${label} ${unique()}`,
      email: `${label}-${unique()}@example.test`,
      passwordHash: 'x',
    },
  });
  createdUserIds.push(user.id);
  return user;
};

/** owner + one agent + one bot, all in one workspace. */
const seedWorkspace = async (label = 'ws') => {
  const owner = await makeUser(`${label}-owner`);
  const workspace = await prisma.workspace.create({
    data: { name: `WS ${unique()}`, ownerId: owner.id },
  });
  createdWorkspaceIds.push(workspace.id);

  await prisma.workspaceMember.create({
    data: { userId: owner.id, workspaceId: workspace.id, role: 'OWNER' },
  });

  const agent = await makeUser(`${label}-agent`);
  const membership = await prisma.workspaceMember.create({
    data: { userId: agent.id, workspaceId: workspace.id, role: 'AGENT' },
  });

  const bot = await prisma.bot.create({
    data: { name: `Bot ${unique()}`, workspaceId: workspace.id },
  });

  return { workspace, bot, owner, agent, membership };
};

type Fixture = Awaited<ReturnType<typeof seedWorkspace>>;

/**
 * A conversation with a live visitor session, seeded directly.
 *
 * `POST /public/bots/:botId/conversations` would be the honest way to make one, and it is
 * deliberately not used: it is IP-rate-limited to 10/min against a store shared by every test
 * in this file, so a suite that started a session per test would spend its time answering 429.
 * The token is minted with the same production `signVisitorToken` the endpoint calls, so what
 * the socket and HTTP layers validate here is the real credential.
 */
const makeConversation = async (
  fx: Fixture,
  options: { status?: 'ACTIVE' | 'WAITING_FOR_HUMAN' | 'HUMAN_ACTIVE' | 'RESOLVED' } = {}
) => {
  const conversation = await prisma.conversation.create({
    data: {
      botId: fx.bot.id,
      workspaceId: fx.workspace.id,
      status: options.status ?? 'ACTIVE',
      assignedAgentId: options.status === 'HUMAN_ACTIVE' ? fx.agent.id : null,
    },
  });

  return {
    conversation,
    visitorToken: signVisitorToken({
      conversationId: conversation.id,
      botId: conversation.botId,
      workspaceId: conversation.workspaceId,
    }),
  };
};

const auth = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

const bearer = (token: string): string => `Bearer ${token}`;

/**
 * A message row with a caller-chosen timestamp.
 *
 * `createdAt` is set explicitly because the cursor tests are *about* timestamps — the tie
 * case, where several messages share one instant, cannot be produced by letting the database
 * stamp them and hoping.
 */
const seedMessages = async (
  conversationId: string,
  specs: { content: string; createdAt: Date }[]
): Promise<{ id: string; content: string; createdAt: Date }[]> => {
  const created = [];
  for (const spec of specs) {
    created.push(
      await prisma.message.create({
        data: {
          conversationId,
          role: 'USER',
          content: spec.content,
          createdAt: spec.createdAt,
        },
      })
    );
  }
  return created;
};

// ---------------------------------------------------------------------------------------
// The live server
// ---------------------------------------------------------------------------------------

let httpServer: HttpServer;
let io: Awaited<ReturnType<typeof attachSocketServer>>;
let baseUrl: string;
let openSockets: ClientSocket[] = [];

/** A client connection attempt whose outcome is awaited rather than raced. */
const openSocket = (token: string | null): Promise<ClientSocket> =>
  new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      auth: token === null ? {} : { token },
      transports: ['websocket'],
      reconnection: false,
      // A distinct Manager per call: without this, socket.io-client would hand back the
      // cached connection for the same URL and the "new" socket would never handshake.
      forceNew: true,
    });

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Socket connect timed out'));
    }, 8000);

    socket.once('connect', () => {
      clearTimeout(timer);
      openSockets.push(socket);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });

/** The error a rejected handshake produces, as the client sees it. */
const expectHandshakeRejection = (token: string | null): Promise<Error> =>
  openSocket(token).then(
    (socket) => {
      socket.close();
      throw new Error('Expected the handshake to be rejected, but the socket connected');
    },
    (error: Error) => error
  );

interface JoinResult {
  ok: boolean;
  error?: string;
  room?: string;
}

/** `room:join` is acknowledged, so authorization is an observable result rather than a timeout. */
const join = (socket: ClientSocket, room: string): Promise<JoinResult> =>
  new Promise((resolve) => socket.emit('room:join', { room }, resolve));

const nextEvent = <T>(socket: ClientSocket, event: string, timeoutMs = 8000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeoutMs);

    const handler = (payload: T): void => {
      clearTimeout(timer);
      resolve(payload);
    };

    socket.once(event, handler);
  });

/** Events that must *not* arrive. Paired with a deterministic positive assertion at each site. */
const collectEvents = <T>(socket: ClientSocket, event: string): T[] => {
  const received: T[] = [];
  socket.on(event, (payload: T) => received.push(payload));
  return received;
};

const settle = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const socketsIn = async (room: string): Promise<number> =>
  (await io.in(room).fetchSockets()).length;

beforeAll(async () => {
  await prisma.$connect();
  httpServer = createServer(app);
  io = attachSocketServer(httpServer);

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(() => {
  vi.clearAllMocks();
  aiMock.chat.mockResolvedValue({
    status: 'success',
    response: 'Nine to five.',
    fallback_required: false,
  });
  openSockets = [];
});

afterEach(async () => {
  // Sockets first: a client left connected would keep its room populated into the next test,
  // and `socketsIn` assertions would then be measuring the previous test's leftovers.
  for (const socket of openSockets) socket.close();
  openSockets = [];

  if (createdWorkspaceIds.length) {
    await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
    createdWorkspaceIds = [];
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
  }
});

afterAll(async () => {
  detachSocketServer(io);
  await new Promise<void>((resolve) => io.close(() => resolve()));
  if (httpServer.listening) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------------------
// §15.2 / §20 — handshake authentication
// ---------------------------------------------------------------------------------------

describe.skipIf(!reachable)('Socket handshake (§15.2, §20)', () => {
  it('rejects a connection with no token', async () => {
    const error = await expectHandshakeRejection(null);
    expect(error.message).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed token', async () => {
    const error = await expectHandshakeRejection('not-a-jwt');
    expect(error.message).toBe('UNAUTHORIZED');
  });

  it('rejects a member token signed with the wrong secret', async () => {
    // Structurally a member token, but not one this server ever issued. The signature check is
    // what refuses it — there is no claim-level heuristic standing in for it.
    const forged = `${signToken({ sub: 'x', email: 'x@example.test' })}tampered`;
    const error = await expectHandshakeRejection(forged);
    expect(error.message).toBe('UNAUTHORIZED');
  });

  it('accepts both token families', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx);

    // The dual-family handshake is §15.2's requirement and the reason `socketAuth` tries the
    // visitor family first: one transport serves the customer widget and the agent dashboard.
    const agentSocket = await openSocket(signToken({ sub: fx.agent.id, email: fx.agent.email }));
    const visitorSocket = await openSocket(session.visitorToken);

    expect(agentSocket.connected).toBe(true);
    expect(visitorSocket.connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// §15.2 / §20 — room authorization
// ---------------------------------------------------------------------------------------

describe.skipIf(!reachable)('Authorized room joins (§15.2, §20)', () => {
  it('lets a member of the workspace join the queue room', async () => {
    const fx = await seedWorkspace();
    const socket = await openSocket(signToken({ sub: fx.agent.id, email: fx.agent.email }));

    const result = await join(socket, workspaceQueueRoom(fx.workspace.id));

    expect(result).toEqual({ ok: true, room: workspaceQueueRoom(fx.workspace.id) });
    expect(await socketsIn(workspaceQueueRoom(fx.workspace.id))).toBe(1);
  });

  it('rejects a member joining another tenant’s queue room', async () => {
    const mine = await seedWorkspace('mine');
    const theirs = await seedWorkspace('theirs');

    const socket = await openSocket(signToken({ sub: mine.agent.id, email: mine.agent.email }));
    const result = await join(socket, workspaceQueueRoom(theirs.workspace.id));

    // The whole cross-tenant socket requirement: a member token proves *who*, membership
    // proves *where*, and the second check is the one that matters here.
    expect(result.ok).toBe(false);
    expect(result.error).toBe('FORBIDDEN');
    expect(await socketsIn(workspaceQueueRoom(theirs.workspace.id))).toBe(0);
  });

  it('rejects a member joining another tenant’s conversation room', async () => {
    const mine = await seedWorkspace('mine');
    const theirs = await seedWorkspace('theirs');
    const theirConversation = await makeConversation(theirs);

    const socket = await openSocket(signToken({ sub: mine.agent.id, email: mine.agent.email }));
    const result = await join(socket, conversationRoom(theirConversation.conversation.id));

    expect(result.ok).toBe(false);
    expect(result.error).toBe('FORBIDDEN');
    expect(await socketsIn(conversationRoom(theirConversation.conversation.id))).toBe(0);
  });

  it('rejects a visitor joining a foreign conversation room', async () => {
    const fx = await seedWorkspace();
    const own = await makeConversation(fx);
    const other = await makeConversation(fx);

    const socket = await openSocket(own.visitorToken);

    // Own room: allowed. The token names exactly this conversation (§10.4).
    expect(await join(socket, conversationRoom(own.conversation.id))).toMatchObject({ ok: true });

    // A conversation in the *same workspace*, reached with a valid visitor token — and still
    // refused. This is the case a workspace-scope check alone would let through, which is why
    // a visitor principal is compared against its own `conversationId` claim instead.
    const foreign = await join(socket, conversationRoom(other.conversation.id));
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toBe('FORBIDDEN');
    expect(await socketsIn(conversationRoom(other.conversation.id))).toBe(0);
  });

  it('never lets a visitor join a queue room', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx);

    const socket = await openSocket(session.visitorToken);

    // Refused before any membership lookup: a customer has no standing in the queue, and the
    // principal kind is checked first so a visitor token cannot probe workspace existence.
    const result = await join(socket, workspaceQueueRoom(fx.workspace.id));
    expect(result.ok).toBe(false);
    expect(result.error).toBe('FORBIDDEN');
  });

  it('rejects room names outside the two subscribable shapes', async () => {
    const fx = await seedWorkspace();
    const socket = await openSocket(signToken({ sub: fx.agent.id, email: fx.agent.email }));

    // Including the private `user:` room, which the server joins on the client's behalf and
    // which grants no read access — a client asking for it is asking for something that is
    // not a subscription, and the answer to an unrecognized room is refusal, not a default.
    for (const room of [
      'workspace:not-a-uuid:queue',
      `user:${fx.agent.id}`,
      `conversation:${fx.bot.id}`,
      'queue',
      `workspace:${fx.workspace.id}`,
      `${conversationRoom(fx.bot.id)}:extra`,
    ]) {
      const result = await join(socket, room);
      expect(result.ok, `expected "${room}" to be rejected`).toBe(false);
      expect(result.error).toBe('FORBIDDEN');
    }
  });

  it('reports a malformed payload rather than a denial', async () => {
    const fx = await seedWorkspace();
    const socket = await openSocket(signToken({ sub: fx.agent.id, email: fx.agent.email }));

    // Distinct from FORBIDDEN: the caller has not been denied anything, they sent no room.
    const result = await new Promise<JoinResult>((resolve) =>
      socket.emit('room:join', { room: 42 }, resolve)
    );
    expect(result).toEqual({ ok: false, error: 'INVALID_ROOM' });
  });
});

// ---------------------------------------------------------------------------------------
// §12.2 / §15.3.3 — post-commit emissions
// ---------------------------------------------------------------------------------------

describe.skipIf(!reachable)('Message broadcasts (§12.2, §15.3.3)', () => {
  it('delivers a customer message to the agent queue and echoes clientMessageId', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx);

    const agentSocket = await openSocket(signToken({ sub: fx.agent.id, email: fx.agent.email }));
    await join(agentSocket, workspaceQueueRoom(fx.workspace.id));

    const received = nextEvent<Record<string, unknown>>(agentSocket, 'message:new');

    const res = await request(httpServer)
      .post(`/api/v1/public/conversations/${session.conversation.id}/messages`)
      .set('Authorization', bearer(session.visitorToken))
      .send({ content: 'Do you open on Sundays?', clientMessageId: 'client-abc-123' });

    expect(res.status).toBe(200);

    const event = await received;
    expect(event).toMatchObject({
      conversationId: session.conversation.id,
      role: 'USER',
      content: 'Do you open on Sundays?',
      // §15.3.3: the id the client invented is echoed both in the record and the broadcast, so
      // it can match the event against the optimistic bubble it already rendered.
      clientMessageId: 'client-abc-123',
    });
    expect(event.id).toBe(res.body.data.userMessage.id);
    expect(res.body.data.userMessage.clientMessageId).toBe('client-abc-123');
  });

  it('delivers an agent reply to the visitor, without staff identity', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx, { status: 'HUMAN_ACTIVE' });

    const visitorSocket = await openSocket(session.visitorToken);
    await join(visitorSocket, conversationRoom(session.conversation.id));

    // A second socket, in the queue room only — so the two projections can be compared
    // without one socket receiving both copies of the same message.
    const agentSocket = await openSocket(signToken({ sub: fx.agent.id, email: fx.agent.email }));
    await join(agentSocket, workspaceQueueRoom(fx.workspace.id));

    const toVisitor = nextEvent<Record<string, unknown>>(visitorSocket, 'message:new');
    const toAgent = nextEvent<Record<string, unknown>>(agentSocket, 'message:new');

    const res = await request(httpServer)
      .post(`/api/v1/conversations/${session.conversation.id}/reply`)
      .set('Authorization', auth(fx.agent))
      .send({ content: 'We are open 9 to 5.' });

    expect(res.status).toBe(201);

    const visitorCopy = await toVisitor;
    const agentCopy = await toAgent;

    expect(visitorCopy).toMatchObject({
      role: 'AGENT',
      content: 'We are open 9 to 5.',
      conversationId: session.conversation.id,
    });

    // The §18.2 boundary, and the reason the two rooms receive different payloads: the
    // customer learns that a person replied (`role: 'AGENT'`) and nothing about *which*
    // person. The staff copy carries the id the dashboard needs.
    expect(visitorCopy).not.toHaveProperty('senderId');
    expect(agentCopy.senderId).toBe(fx.agent.id);
  });

  it('emits nothing to a workspace the message does not belong to', async () => {
    const mine = await seedWorkspace('mine');
    const theirs = await seedWorkspace('theirs');
    const session = await makeConversation(mine);

    const outsiderSocket = await openSocket(
      signToken({ sub: theirs.agent.id, email: theirs.agent.email })
    );
    // The outsider is in their *own* queue room, which is the room most likely to leak if an
    // emission were ever addressed by conversation rather than by the row's workspace.
    await join(outsiderSocket, workspaceQueueRoom(theirs.workspace.id));
    const leaked = collectEvents<unknown>(outsiderSocket, 'message:new');

    const res = await request(httpServer)
      .post(`/api/v1/public/conversations/${session.conversation.id}/messages`)
      .set('Authorization', bearer(session.visitorToken))
      .send({ content: 'hello' });

    expect(res.status).toBe(200);

    // Positive control: the same emission reached the owning workspace, so the empty list
    // below means "delivered elsewhere", not "never emitted".
    const insiderSocket = await openSocket(
      signToken({ sub: mine.agent.id, email: mine.agent.email })
    );
    await join(insiderSocket, workspaceQueueRoom(mine.workspace.id));

    const followUp = nextEvent(insiderSocket, 'message:new');
    await request(httpServer)
      .post(`/api/v1/public/conversations/${session.conversation.id}/messages`)
      .set('Authorization', bearer(session.visitorToken))
      .send({ content: 'again' });
    await followUp;

    await settle();
    expect(leaked).toHaveLength(0);
  });

  it('announces an escalation on the customer room and nudges the queue', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx);

    aiMock.chat.mockResolvedValue({
      status: 'fallback',
      response: 'platform copy',
      fallback_required: true,
      reason: 'LLM_INSUFFICIENT_INFORMATION',
    });

    const visitorSocket = await openSocket(session.visitorToken);
    await join(visitorSocket, conversationRoom(session.conversation.id));

    const agentSocket = await openSocket(signToken({ sub: fx.agent.id, email: fx.agent.email }));
    await join(agentSocket, workspaceQueueRoom(fx.workspace.id));

    const escalated = nextEvent<Record<string, unknown>>(visitorSocket, 'conversation:escalated');
    const queueUpdated = nextEvent<Record<string, unknown>>(agentSocket, 'queue:updated');

    await request(httpServer)
      .post(`/api/v1/public/conversations/${session.conversation.id}/messages`)
      .set('Authorization', bearer(session.visitorToken))
      .send({ content: 'Something you cannot answer' });

    // The customer is told a human is coming; the agents are told the queue changed (§16.1).
    expect(await escalated).toMatchObject({
      conversationId: session.conversation.id,
      status: 'WAITING_FOR_HUMAN',
      escalationReason: 'LLM_INSUFFICIENT_INFORMATION',
    });

    expect(await queueUpdated).toMatchObject({
      conversationId: session.conversation.id,
      status: 'WAITING_FOR_HUMAN',
    });

    const row = await prisma.conversation.findUniqueOrThrow({
      where: { id: session.conversation.id },
    });
    expect(row.status).toBe('WAITING_FOR_HUMAN');
  });

  it('announces a claim, and only the winner of a race announces one', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx, { status: 'WAITING_FOR_HUMAN' });

    const socket = await openSocket(signToken({ sub: fx.agent.id, email: fx.agent.email }));
    await join(socket, workspaceQueueRoom(fx.workspace.id));
    const claimed = collectEvents<Record<string, unknown>>(socket, 'conversation:claimed');

    const first = await request(httpServer)
      .post(`/api/v1/conversations/${session.conversation.id}/claim`)
      .set('Authorization', auth(fx.agent));
    expect(first.status).toBe(200);

    // A second claim loses the guard race and must therefore emit nothing. The emission is
    // built from the row the transition *wrote*, so a refused transition has no row to
    // announce — a loser that broadcast anyway would be reporting a claim that did not happen.
    const second = await request(httpServer)
      .post(`/api/v1/conversations/${session.conversation.id}/claim`)
      .set('Authorization', auth(fx.agent));
    expect(second.status).toBe(409);

    await settle();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      conversationId: session.conversation.id,
      status: 'HUMAN_ACTIVE',
      assignedAgentId: fx.agent.id,
      actorId: fx.agent.id,
    });
  });

  it('does not nudge the queue for a message on a conversation the AI owns', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx);

    const socket = await openSocket(signToken({ sub: fx.agent.id, email: fx.agent.email }));
    await join(socket, workspaceQueueRoom(fx.workspace.id));
    const nudges = collectEvents<unknown>(socket, 'queue:updated');
    const messages = collectEvents<unknown>(socket, 'message:new');

    await request(httpServer)
      .post(`/api/v1/public/conversations/${session.conversation.id}/messages`)
      .set('Authorization', bearer(session.visitorToken))
      .send({ content: 'hi' });

    await settle();

    // The message itself is still broadcast — the conversation room is watching it — but an
    // `ACTIVE` conversation appears in no queue view, so a `queue:updated` here would make
    // every agent refetch a list that cannot have changed.
    expect(messages.length).toBeGreaterThan(0);
    expect(nudges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// §20 — revoked member socket disconnect
// ---------------------------------------------------------------------------------------

describe.skipIf(!reachable)('Revoked member eviction (§20)', () => {
  it('disconnects the removed member and never notifies them', async () => {
    const fx = await seedWorkspace();

    // A ticket the departing agent is handling, so the revocation has something to release.
    const conversation = await prisma.conversation.create({
      data: {
        botId: fx.bot.id,
        workspaceId: fx.workspace.id,
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agent.id,
      },
    });

    const agentSocket = await openSocket(signToken({ sub: fx.agent.id, email: fx.agent.email }));
    await join(agentSocket, workspaceQueueRoom(fx.workspace.id));
    expect(await socketsIn(workspaceQueueRoom(fx.workspace.id))).toBe(1);

    // Events the departing member must not receive: the queue nudge and the unassignment of
    // their own ticket, both of which are emitted *after* the membership change commits.
    const leakedQueue = collectEvents<unknown>(agentSocket, 'queue:updated');
    const leakedUnassign = collectEvents<unknown>(agentSocket, 'conversation:unassigned');

    const disconnected = nextEvent<string>(agentSocket, 'disconnect');

    const res = await request(httpServer)
      .delete(`/api/v1/workspaces/${fx.workspace.id}/members/${fx.membership.id}`)
      .set('Authorization', auth(fx.owner));

    expect(res.status).toBe(200);

    // The socket is closed, not merely unsubscribed: a token minted before the revocation
    // still authenticates, so leaving the connection up would mean the denial depends on the
    // authorizer staying correct forever rather than on the credential being gone.
    expect(await disconnected).toBe('io server disconnect');

    // Server-side, and therefore independent of any timing on the client: the room is empty.
    expect(await socketsIn(workspaceQueueRoom(fx.workspace.id))).toBe(0);

    await settle();
    expect(leakedQueue).toHaveLength(0);
    expect(leakedUnassign).toHaveLength(0);
  });

  it('returns the revoked member’s tickets to the queue', async () => {
    const fx = await seedWorkspace();

    const conversation = await prisma.conversation.create({
      data: {
        botId: fx.bot.id,
        workspaceId: fx.workspace.id,
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agent.id,
      },
    });

    // An observer who is *not* revoked. The eviction must be scoped to the departing member:
    // a workspace-wide disconnect would take every agent in the tenant offline on any
    // offboarding, which is a denial of service dressed as a security control.
    const observerSocket = await openSocket(signToken({ sub: fx.owner.id, email: fx.owner.email }));
    await join(observerSocket, workspaceQueueRoom(fx.workspace.id));

    const unassigned = nextEvent<Record<string, unknown>>(observerSocket, 'conversation:unassigned');

    const res = await request(httpServer)
      .delete(`/api/v1/workspaces/${fx.workspace.id}/members/${fx.membership.id}`)
      .set('Authorization', auth(fx.owner));

    expect(res.status).toBe(200);

    expect(await unassigned).toMatchObject({
      conversationId: conversation.id,
      status: 'WAITING_FOR_HUMAN',
      assignedAgentId: null,
    });

    const row = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    expect(row.status).toBe('WAITING_FOR_HUMAN');
    expect(row.assignedAgentId).toBeNull();

    expect(observerSocket.connected).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// §15.3 — cursor recovery
// ---------------------------------------------------------------------------------------

describe.skipIf(!reachable)('Cursor recovery (§15.3)', () => {
  const BASE = new Date('2026-01-01T00:00:00.000Z');
  const at = (ms: number): Date => new Date(BASE.getTime() + ms);

  const fetchAfter = (
    conversationId: string,
    fx: Fixture,
    cursor: { createdAt: Date; id: string },
    limit?: number
  ) =>
    request(httpServer)
      .get(`/api/v1/conversations/${conversationId}/messages`)
      .query({
        afterCreatedAt: cursor.createdAt.toISOString(),
        afterId: cursor.id,
        ...(limit === undefined ? {} : { limit }),
      })
      .set('Authorization', auth(fx.agent));

  it('returns only messages strictly after the cursor', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx);

    const seeded = await seedMessages(session.conversation.id, [
      { content: 'm1', createdAt: at(0) },
      { content: 'm2', createdAt: at(1000) },
      { content: 'm3', createdAt: at(2000) },
      { content: 'm4', createdAt: at(3000) },
    ]);

    const res = await fetchAfter(session.conversation.id, fx, seeded[1]);

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((m: { content: string }) => m.content)).toEqual(['m3', 'm4']);
    // The cursor message is *not* re-delivered: §15.3.4 backfills what was missed, and the
    // client already has the message it resumed from.
    expect(res.body.data.items.map((m: { id: string }) => m.id)).not.toContain(seeded[1].id);
  });

  it('does not skip a message that shares the cursor’s timestamp', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx);

    // All five at the same instant — the shape a bot reply and the escalation it triggers
    // produce, since both are written inside one transaction. This is the case that makes
    // `createdAt > cursor` insufficient: on its own it returns *nothing* here.
    const instant = at(5000);
    const seeded = await seedMessages(
      session.conversation.id,
      ['a', 'b', 'c', 'd', 'e'].map((content) => ({ content, createdAt: instant }))
    );

    const ordered = [...seeded].sort((left, right) => (left.id < right.id ? -1 : 1));
    const cursor = ordered[1];

    const res = await fetchAfter(session.conversation.id, fx, cursor);

    expect(res.status).toBe(200);
    // Exactly the three that sort after the cursor in `(createdAt, id)` order — including the
    // two that share its timestamp, and excluding the one that shares it and sorts before.
    //
    // Compared against the id-derived order rather than a hand-written list: message ids are
    // random uuids, so the sort order is a permutation of creation order and a hard-coded
    // expectation would be asserting the uuid generator's output, not the query's.
    expect(res.body.data.items.map((m: { id: string }) => m.id)).toEqual(
      ordered.slice(2).map((m) => m.id)
    );
    expect(res.body.data.items.map((m: { content: string }) => m.content)).toEqual(
      ordered.slice(2).map((m) => m.content)
    );
  });

  it('pages with nextCursor and stops offering a cursor once caught up', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx);

    const seeded = await seedMessages(
      session.conversation.id,
      [0, 1, 2, 3].map((n) => ({ content: `m${n}`, createdAt: at(n * 1000) }))
    );

    const first = await fetchAfter(session.conversation.id, fx, seeded[0], 2);
    expect(first.status).toBe(200);
    expect(first.body.data.items.map((m: { content: string }) => m.content)).toEqual(['m1', 'm2']);
    expect(first.body.data.nextCursor).toMatchObject({ afterId: seeded[2].id });

    // Resume from the server-supplied cursor rather than recomputing it: this is exactly the
    // client loop §15.3.4 describes.
    const second = await request(httpServer)
      .get(`/api/v1/conversations/${session.conversation.id}/messages`)
      .query({
        afterCreatedAt: first.body.data.nextCursor.afterCreatedAt,
        afterId: first.body.data.nextCursor.afterId,
      })
      .set('Authorization', auth(fx.agent));

    expect(second.body.data.items.map((m: { content: string }) => m.content)).toEqual(['m3']);
    // A short page means the caller has caught up; a cursor here would invite a poll that can
    // never return anything.
    expect(second.body.data.nextCursor).toBeNull();
  });

  it('rejects a half-supplied cursor', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx);
    const seeded = await seedMessages(session.conversation.id, [
      { content: 'm1', createdAt: at(0) },
    ]);

    const both = await request(httpServer)
      .get(`/api/v1/conversations/${session.conversation.id}/messages`)
      .query({ afterCreatedAt: seeded[0].createdAt.toISOString(), afterId: seeded[0].id })
      .set('Authorization', auth(fx.agent));
    expect(both.status).toBe(200);

    // `afterCreatedAt` alone would silently loosen `>` to `>=` and re-deliver the boundary
    // message; `afterId` alone names no position. Neither is a cursor, so neither is accepted.
    for (const query of [
      { afterCreatedAt: seeded[0].createdAt.toISOString() },
      { afterId: seeded[0].id },
      { afterCreatedAt: 'yesterday', afterId: seeded[0].id },
      { afterCreatedAt: seeded[0].createdAt.toISOString(), afterId: 'not-a-uuid' },
    ]) {
      const res = await request(httpServer)
        .get(`/api/v1/conversations/${session.conversation.id}/messages`)
        .query(query)
        .set('Authorization', auth(fx.agent));
      expect(res.status, `expected ${JSON.stringify(query)} to be rejected`).toBe(400);
    }
  });

  it('recovers the messages a disconnected client missed (§15.3.4)', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx, { status: 'WAITING_FOR_HUMAN' });

    const agentSocket = await openSocket(signToken({ sub: fx.agent.id, email: fx.agent.email }));
    await join(agentSocket, workspaceQueueRoom(fx.workspace.id));

    // The agent sees the first message, then loses their connection.
    const firstSeen = nextEvent<Record<string, unknown>>(agentSocket, 'message:new');
    await request(httpServer)
      .post(`/api/v1/public/conversations/${session.conversation.id}/messages`)
      .set('Authorization', bearer(session.visitorToken))
      .send({ content: 'first' });

    const lastSeen = await firstSeen;
    agentSocket.close();

    // Two messages arrive while nobody is listening. These broadcasts are genuinely lost —
    // there is no replay buffer — which is the whole reason the recovery path exists.
    for (const content of ['second', 'third']) {
      const res = await request(httpServer)
        .post(`/api/v1/public/conversations/${session.conversation.id}/messages`)
        .set('Authorization', bearer(session.visitorToken))
        .send({ content });
      expect(res.status).toBe(200);
    }

    // Reconnect, then resume from the newest `(createdAt, id)` the client actually holds.
    const resumed = await fetchAfter(session.conversation.id, fx, {
      createdAt: new Date(lastSeen.createdAt as string),
      id: lastSeen.id as string,
    });

    expect(resumed.status).toBe(200);
    const contents = resumed.body.data.items.map((m: { content: string }) => m.content);
    expect(contents).toContain('second');
    expect(contents).toContain('third');
    // …and nothing the client already had.
    expect(contents).not.toContain('first');
  });

  it('serves the same recovery contract on the visitor surface', async () => {
    const fx = await seedWorkspace();
    const session = await makeConversation(fx, { status: 'WAITING_FOR_HUMAN' });

    const seeded = await seedMessages(session.conversation.id, [
      { content: 'v1', createdAt: at(0) },
      { content: 'v2', createdAt: at(1000) },
      { content: 'v3', createdAt: at(2000) },
    ]);

    const res = await request(httpServer)
      .get(`/api/v1/public/conversations/${session.conversation.id}/messages`)
      .query({
        afterCreatedAt: seeded[0].createdAt.toISOString(),
        afterId: seeded[0].id,
      })
      .set('Authorization', bearer(session.visitorToken));

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((m: { content: string }) => m.content)).toEqual(['v2', 'v3']);
    // §18.2 holds on the recovery path too: the visitor projection carries no staff identity
    // and no internal fields, so backfilling cannot become a route to data the tail read hides.
    for (const item of res.body.data.items) {
      expect(item).not.toHaveProperty('senderId');
    }
  });

  it('scopes the cursor to the caller’s workspace', async () => {
    const mine = await seedWorkspace('mine');
    const theirs = await seedWorkspace('theirs');
    const theirConversation = await makeConversation(theirs);
    const seeded = await seedMessages(theirConversation.conversation.id, [
      { content: 'secret', createdAt: at(0) },
    ]);

    const res = await fetchAfter(theirConversation.conversation.id, mine, seeded[0]);

    // 404 rather than an empty page: a foreign conversation id must not be distinguishable
    // from a nonexistent one (§8, §18.1).
    expect(res.status).toBe(404);
  });
});
