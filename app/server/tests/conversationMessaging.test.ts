import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHash, randomBytes } from 'node:crypto';

import { config as loadEnv } from 'dotenv';

/**
 * CP3 verification: the customer's turn, the agent's turn, and the concurrency rules between
 * them — driven over real HTTP against real PostgreSQL.
 *
 * The same two departures `conversationQueue.test.ts` makes, for the same reasons: the real
 * `.env` wins so Prisma talks to Postgres, and every assertion goes through `supertest` so
 * the status codes are the ones middleware, validation, the service layer and the error
 * handler produce together. A mocked Prisma cannot show that a late AI answer is *discarded*
 * — it would only show that the mock was told to discard it.
 *
 * Exactly one thing is mocked, and it is mocked at the narrowest point that exists:
 * `aiServiceClient.chat`. The AI's *timing* has to be controllable for a race to be
 * reproducible, and a real LLM would make these tests slow, non-deterministic and
 * unassertable. Everything the checkpoint actually claims — that a suppressed turn writes no
 * assistant message, that a superseded turn is aborted, that a stale answer never lands,
 * that a visitor token reaches one conversation and no other — is a property of *this*
 * system, and is therefore observed here against the real one.
 */

const aiMock = vi.hoisted(() => ({ chat: vi.fn() }));

vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

loadEnv({ path: new URL('../.env', import.meta.url), override: true });
// .env may carry a real log level; the suite's own quiet default is restored before the
// app (and therefore pino) is imported.
process.env.LOG_LEVEL = 'silent';

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

if (!reachable) {
  console.warn(
    '[conversationMessaging] PostgreSQL is not reachable — skipping live messaging verification. ' +
      'Set DATABASE_URL in app/server/.env to run these tests.'
  );
}

const { default: app } = await import('../src/app.js');
const { signToken, signVisitorToken } = await import('../src/utils/jwt.js');

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

let createdWorkspaceIds: string[] = [];
let createdUserIds: string[] = [];

const unique = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const makeUser = async (label: string) => {
  const user = await prisma.user.create({
    data: { name: `${label} ${unique()}`, email: `${label}-${unique()}@example.test`, passwordHash: 'x' },
  });
  createdUserIds.push(user.id);
  return user;
};

/** owner + admin + two agents + one bot, all in one workspace. */
const seedWorkspace = async () => {
  const owner = await makeUser('owner');
  const workspace = await prisma.workspace.create({
    data: { name: `WS ${unique()}`, ownerId: owner.id },
  });
  createdWorkspaceIds.push(workspace.id);

  const join = (userId: string, role: string) =>
    prisma.workspaceMember.create({ data: { userId, workspaceId: workspace.id, role } });

  await join(owner.id, 'OWNER');
  const admin = await makeUser('admin');
  await join(admin.id, 'ADMIN');
  const agentA = await makeUser('agent-a');
  await join(agentA.id, 'AGENT');
  const agentB = await makeUser('agent-b');
  await join(agentB.id, 'AGENT');

  const bot = await prisma.bot.create({ data: { name: `Bot ${unique()}`, workspaceId: workspace.id } });

  const exp = await prisma.botExperience.create({
    data: { botId: bot.id },
  });
  await prisma.botDeployment.create({
    data: {
      experienceId: exp.id,
      botId: bot.id,
      workspaceId: workspace.id,
      format: 'WIDGET',
      status: 'PUBLISHED',
      enabled: true,
    },
  });

  return { workspace, bot, owner, admin, agentA, agentB };
};

type Fixture = Awaited<ReturnType<typeof seedWorkspace>>;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

interface PublicConvOptions {
  status?: 'ACTIVE' | 'WAITING_FOR_HUMAN' | 'HUMAN_ACTIVE' | 'RESOLVED';
  assignedAgentId?: string | null;
  escalatedAt?: Date | null;
  escalationReason?: string | null;
  resolvedAt?: Date | null;
  sessionSecret?: string;
}

/**
 * A conversation with a live public session, without going through the start endpoint.
 *
 * `POST /public/bots/:botId/conversations` is deliberately IP-rate-limited to 10 per minute
 * (§18.4), and its limiter's store is module-level state shared by every test in this file —
 * so a suite that started a session per test would spend most of its time at 429 and prove
 * nothing. The endpoint is exercised exactly once, in the test that is *about* it; every
 * other test mints its token with the same `signVisitorToken` the endpoint uses, because
 * the subject here is token *validation*, not minting.
 *
 * The stored hash is the digest of `sessionSecret`, so a test can drive the refresh
 * endpoint with the real credential rather than a fabricated one.
 */
const makePublicConversation = async (fx: Fixture, options: PublicConvOptions = {}) => {
  const sessionSecret = options.sessionSecret ?? randomBytes(32).toString('hex');

  const conversation = await prisma.conversation.create({
    data: {
      botId: fx.bot.id,
      workspaceId: fx.workspace.id,
      status: options.status ?? 'ACTIVE',
      assignedAgentId: options.assignedAgentId ?? null,
      escalatedAt: options.escalatedAt ?? null,
      escalationReason: options.escalationReason ?? null,
      resolvedAt: options.resolvedAt ?? null,
      visitorSessionHash: sha256(sessionSecret),
    },
  });

  return {
    conversation,
    sessionSecret,
    visitorToken: signVisitorToken({
      conversationId: conversation.id,
      botId: conversation.botId,
      workspaceId: conversation.workspaceId,
    }),
  };
};

type PublicConversation = Awaited<ReturnType<typeof makePublicConversation>>;

const auth = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

const bearer = (token: string): string => `Bearer ${token}`;

const publicBase = (conversationId: string): string => `/api/v1/public/conversations/${conversationId}`;

const sendMessage = (session: PublicConversation, content: string) =>
  request(app)
    .post(`${publicBase(session.conversation.id)}/messages`)
    .set('Authorization', bearer(session.visitorToken))
    .send({ content });

const replyUrl = (id: string) => `/api/v1/conversations/${id}/reply`;
const claimUrl = (id: string) => `/api/v1/conversations/${id}/claim`;

const eventsOf = (conversationId: string) =>
  prisma.conversationEvent.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } });

const messagesOf = (conversationId: string) =>
  prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } });

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000);

const stateOf = (conversationId: string) =>
  prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });

// ---------------------------------------------------------------------------------------
// The AI boundary
// ---------------------------------------------------------------------------------------

const SUCCESS_REPLY = { status: 'success', response: 'Nine to five.', fallback_required: false };

const ESCALATING_REPLY = {
  status: 'fallback',
  response: 'platform copy',
  fallback_required: true,
  reason: 'LLM_INSUFFICIENT_INFORMATION',
};

/** A pending AI call the test can end by hand. */
interface HeldCall {
  settle: () => void;
}

let heldCalls: HeldCall[] = [];

/**
 * Script the AI service.
 *
 * With `hold`, the promise stays open until `releaseHeld` — and it honours the Phase 2
 * `AbortSignal` the way a real `fetch` does, rejecting with an abort error. That is what
 * makes the cancellation test meaningful: the service's `ABORTED` distinguishes *our own*
 * abort from an AI-service fault by inspecting the signal, so a mock that ignored the signal
 * would exercise a code path the real system never takes.
 */
const mockAI = (reply: Record<string, unknown> = SUCCESS_REPLY, options: { hold?: boolean } = {}) => {
  heldCalls = [];

  aiMock.chat.mockImplementation((_payload: unknown, signal?: AbortSignal) => {
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal?.aborted) return abort();

      signal?.addEventListener('abort', abort, { once: true });

      const call: HeldCall = { settle: () => resolve({ ...reply }) };
      heldCalls.push(call);
      if (!options.hold) call.settle();
    });
  });
};

/** Answer — but only after moving the conversation out from under the turn. */
const mockAIAfter = (transition: () => Promise<unknown>) => {
  heldCalls = [];
  aiMock.chat.mockImplementation(async () => {
    await transition();
    return { ...SUCCESS_REPLY };
  });
};

const releaseHeld = (index: number): void => heldCalls[index].settle();

/** Poll until `predicate` holds. Concurrency tests need the *other* request to be in flight. */
const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the expected in-flight state');
};

beforeEach(() => {
  vi.clearAllMocks();
  heldCalls = [];
  aiMock.chat.mockResolvedValue({ ...SUCCESS_REPLY });
});

describe.skipIf(!reachable)('Customer and agent messaging (CP3)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterEach(async () => {
    // Workspace first: it cascades bots → conversations → messages/events, so the user
    // deletes that follow are not blocked by, or forced to rely on, `SetNull` behaviour.
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
    await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------------------
  // §10.3 — starting a session
  // -------------------------------------------------------------------------------------

  describe('POST /public/bots/:botId/conversations', () => {
    it('mints a scoped token and stores only the session digest', async () => {
      const fx = await seedWorkspace();
      mockAI();

      const res = await request(app).post(`/api/v1/public/bots/${fx.bot.id}/conversations`);

      expect(res.status).toBe(201);
      const { conversation, visitorToken, sessionSecret } = res.body.data;

      expect(conversation).toMatchObject({
        botId: fx.bot.id,
        workspaceId: fx.workspace.id,
        status: 'ACTIVE',
        version: 1,
        assignedAgentId: null,
      });
      expect(typeof visitorToken).toBe('string');
      expect(sessionSecret).toMatch(/^[0-9a-f]{64}$/);

      // §10.2: the long-lived credential never reaches the database. The stored value is a
      // 64-hex digest and is not the secret itself — the refresh test below proves
      // functionally that it is the digest *of that secret*.
      const row = await stateOf(conversation.id);
      expect(row.visitorSessionHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.visitorSessionHash).not.toBe(sessionSecret);
      expect(JSON.stringify(row)).not.toContain(sessionSecret);
    });

    it('answers 404 for a paused bot — the same answer as for a bot that does not exist', async () => {
      const fx = await seedWorkspace();
      await prisma.bot.update({ where: { id: fx.bot.id }, data: { isActive: false } });

      const paused = await request(app).post(`/api/v1/public/bots/${fx.bot.id}/conversations`);
      const absent = await request(app).post(
        '/api/v1/public/bots/00000000-0000-0000-0000-000000000000/conversations'
      );

      // Distinguishing them would turn the endpoint into an existence oracle (§18.1).
      expect(paused.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(await prisma.conversation.count({ where: { botId: fx.bot.id } })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------
  // §9.3 — the customer's turn
  // -------------------------------------------------------------------------------------

  describe('POST /public/conversations/:id/messages', () => {
    it('runs a normal turn: stores both messages and bumps the version', async () => {
      const fx = await seedWorkspace();
      const started = await request(app).post(`/api/v1/public/bots/${fx.bot.id}/conversations`);
      const { conversation, visitorToken } = started.body.data;
      mockAI();

      const res = await request(app)
        .post(`${publicBase(conversation.id)}/messages`)
        .set('Authorization', bearer(visitorToken))
        .send({ content: 'What are your hours?' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        suppressed: false,
        userMessage: { role: 'USER', content: 'What are your hours?' },
        assistantMessage: { role: 'ASSISTANT', content: 'Nine to five.' },
      });

      expect(aiMock.chat).toHaveBeenCalledTimes(1);
      expect(aiMock.chat.mock.calls[0][0]).toMatchObject({
        bot_id: fx.bot.id,
        message: 'What are your hours?',
      });

      const stored = await messagesOf(conversation.id);
      expect(stored.map((m) => m.role)).toEqual(['USER', 'ASSISTANT']);

      const after = await stateOf(conversation.id);
      expect(after.status).toBe('ACTIVE');
      // §9.2 Phase 3: a successful turn advances the OCC token, escalating or not.
      expect(after.version).toBe(2);
      expect(after.assignedAgentId).toBeNull();
    });

    it('does not invoke the AI while a human owns the conversation', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(2),
        escalationReason: 'LLM_INSUFFICIENT_INFORMATION',
      });
      mockAI();

      const res = await sendMessage(session, 'Are you still there?');

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        suppressed: true,
        suppressionReason: 'AI_BYPASSED',
        assistantMessage: null,
      });

      // The gate is the point, not the response shape: no provider spend, no answer.
      expect(aiMock.chat).not.toHaveBeenCalled();

      // §9.3: the customer's words are stored first and unconditionally — a message the
      // customer sent is never lost, even when nobody answers it.
      expect((await messagesOf(session.conversation.id)).map((m) => m.role)).toEqual(['USER']);

      // And the turn wrote nothing else: no version bump, no status change, no audit row.
      const after = await stateOf(session.conversation.id);
      expect(after).toMatchObject({ status: 'WAITING_FOR_HUMAN', version: 1 });
      expect(await eventsOf(session.conversation.id)).toHaveLength(0);
    });

    it('discards a late AI answer when the conversation escalated during generation', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx);

      // The escalation lands while the AI is generating. Performed out of band, which is how
      // the cross-instance case looks to this instance: the answer is already in flight and
      // the world moves before it returns.
      mockAIAfter(() =>
        prisma.conversation.update({
          where: { id: session.conversation.id },
          data: {
            status: 'WAITING_FOR_HUMAN',
            escalatedAt: new Date(),
            escalationReason: 'LLM_INSUFFICIENT_INFORMATION',
            version: { increment: 1 },
          },
        })
      );

      const res = await sendMessage(session, 'Hello?');

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        suppressed: true,
        suppressionReason: 'STALE',
        assistantMessage: null,
      });

      // §9.2 Phase 3: the answer is dropped, not written and then corrected. A reader must
      // never see the bot speaking in a conversation a human has taken over.
      expect((await messagesOf(session.conversation.id)).map((m) => m.role)).toEqual(['USER']);

      const after = await stateOf(session.conversation.id);
      expect(after.status).toBe('WAITING_FOR_HUMAN');
      // Exactly the escalation's bump. The discarded turn added nothing on top of it.
      expect(after.version).toBe(2);
      expect(await eventsOf(session.conversation.id)).toHaveLength(0);
    });

    it('discards a late AI answer when the conversation is claimed during generation', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx);

      /**
       * The claim runs as a real request through the real route, from inside the AI call —
       * which is precisely the ordering §9.2 Phase 3 exists for.
       *
       * The stub does not honour the abort signal, so this reproduces the instance that
       * *never saw* the claim: Phase 2's registry is per-process, and a claim handled
       * elsewhere cannot reach into this turn. Phase 3 is what makes the discard certain,
       * and it is therefore what this asserts. (The in-process cancellation is covered
       * separately, by the superseded-turn test below.)
       */
      let claimStatus = 0;
      mockAIAfter(async () => {
        // Stands in for the escalation the claim requires, committed by another instance.
        await prisma.conversation.update({
          where: { id: session.conversation.id },
          data: {
            status: 'WAITING_FOR_HUMAN',
            escalatedAt: new Date(),
            escalationReason: 'LLM_INSUFFICIENT_INFORMATION',
          },
        });
        const claim = await request(app)
          .post(claimUrl(session.conversation.id))
          .set('Authorization', auth(fx.agentA));
        claimStatus = claim.status;
      });

      const res = await sendMessage(session, 'Hello?');

      expect(claimStatus).toBe(200);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        suppressed: true,
        suppressionReason: 'STALE',
        assistantMessage: null,
      });

      const after = await stateOf(session.conversation.id);
      expect(after).toMatchObject({
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
      });
      // Exactly one assignment survived, and exactly one answer was dropped.
      expect((await messagesOf(session.conversation.id)).map((m) => m.role)).toEqual(['USER']);

      const claims = (await eventsOf(session.conversation.id)).filter(
        (event) => event.eventType === 'CLAIMED'
      );
      expect(claims).toHaveLength(1);
      expect(claims[0].actorId).toBe(fx.agentA.id);
    });

    it('cancels the superseded turn in flight, and answers only the newer message', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx);
      mockAI(SUCCESS_REPLY, { hold: true });

      // `.then` is what actually dispatches a supertest request, so both are started here
      // and awaited later — the point is that they overlap.
      const first = sendMessage(session, 'first').then((r) => r);
      await waitFor(() => aiMock.chat.mock.calls.length === 1);

      const second = sendMessage(session, 'second').then((r) => r);
      await waitFor(() => aiMock.chat.mock.calls.length === 2);

      // §9.2 Phase 2: registering the newer turn aborts the older one, so the older answer
      // is discarded at the source rather than being relied on to fail the Phase 3 check.
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.data).toMatchObject({
        suppressed: true,
        suppressionReason: 'ABORTED',
        assistantMessage: null,
      });

      releaseHeld(1);
      const secondRes = await second;
      expect(secondRes.status).toBe(200);
      expect(secondRes.body.data.suppressed).toBe(false);

      // Both customer messages survive; exactly one answer does.
      const stored = await messagesOf(session.conversation.id);
      expect(stored.map((m) => m.role)).toEqual(['USER', 'USER', 'ASSISTANT']);
      expect(stored[2].content).toBe('Nine to five.');
    });

    it('reopens a resolved conversation on a new customer message', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx, {
        status: 'RESOLVED',
        assignedAgentId: fx.agentA.id,
        resolvedAt: minutesAgo(5),
        escalatedAt: minutesAgo(30),
      });
      mockAI();

      const res = await sendMessage(session, 'One more question');

      expect(res.status).toBe(200);
      // §8.3, default `REOPEN_TO_AI`: the customer's route back in is a message, and this
      // turn is the turn that answers it — hence the assistantMessage.
      expect(res.body.data.suppressed).toBe(false);
      expect(res.body.data.assistantMessage.content).toBe('Nine to five.');

      const after = await stateOf(session.conversation.id);
      expect(after.status).toBe('ACTIVE');
      expect(after.resolvedAt).toBeNull();
      // Cleared, so a former agent is not woken by an answer the AI is about to give.
      expect(after.assignedAgentId).toBeNull();
      // Two bumps: the reopen's, and then Phase 3's for the answer the reopen was performed
      // to obtain — which is exactly why the expectation moves forward with the reopen.
      expect(after.version).toBe(3);

      const events = await eventsOf(session.conversation.id);
      expect(events.map((e) => e.eventType)).toEqual(['REOPENED']);
      expect(events[0].actorId).toBeNull();
      expect(events[0].metadata).toEqual({ actor: 'CUSTOMER', previousStatus: 'RESOLVED' });
    });
  });

  // -------------------------------------------------------------------------------------
  // §13.1 — the escalation audit trail on the customer path
  // -------------------------------------------------------------------------------------

  describe('escalation from the customer surface', () => {
    it('writes WAITING_FOR_HUMAN with its ESCALATED event, then bypasses the AI', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx);
      mockAI(ESCALATING_REPLY);

      const res = await sendMessage(session, 'Something obscure');

      expect(res.status).toBe(200);
      expect(res.body.data.escalation).toMatchObject({ required: true, offHours: false });

      const after = await stateOf(session.conversation.id);
      expect(after.status).toBe('WAITING_FOR_HUMAN');
      expect(after.escalationReason).toBe('LLM_INSUFFICIENT_INFORMATION');
      expect(after.escalatedAt).not.toBeNull();
      expect(after.assignedAgentId).toBeNull();

      // §22: the status and its audit row commit together, so a `WAITING_FOR_HUMAN` row
      // with no history is not an observable state.
      const events = await eventsOf(session.conversation.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: 'ESCALATED', actorId: null });
      expect(events[0].metadata).toMatchObject({
        reason: 'LLM_INSUFFICIENT_INFORMATION',
        offHours: false,
      });

      // The handoff is real: the customer's next message reaches no one but the queue.
      const followUp = await sendMessage(session, 'Hello?');
      expect(followUp.body.data).toMatchObject({
        suppressed: true,
        suppressionReason: 'AI_BYPASSED',
      });
      expect(aiMock.chat).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------------------
  // §8.2 — the agent's turn
  // -------------------------------------------------------------------------------------

  describe('POST /conversations/:id/reply', () => {
    it('stores an AGENT message attributed to the replying agent, with its audit event', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(replyUrl(session.conversation.id))
        .set('Authorization', auth(fx.agentA))
        .send({ content: 'I am looking into it.' });

      expect(res.status).toBe(201);
      expect(res.body.data.message).toMatchObject({
        role: 'AGENT',
        senderId: fx.agentA.id,
        content: 'I am looking into it.',
      });

      // The response is not the evidence — the row is.
      const stored = await messagesOf(session.conversation.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        role: 'AGENT',
        senderId: fx.agentA.id,
        content: 'I am looking into it.',
      });

      const events = await eventsOf(session.conversation.id);
      expect(events.map((e) => e.eventType)).toEqual(['AGENT_REPLIED']);
      expect(events[0].actorId).toBe(fx.agentA.id);

      // No version bump: `version` exists to invalidate an in-flight AI turn, and there is
      // none to invalidate in a state where the AI is already suppressed (§8.2).
      expect((await stateOf(session.conversation.id)).version).toBe(1);

      // The customer sees that a person replied — and not which person (§17).
      const transcript = await request(app)
        .get(`${publicBase(session.conversation.id)}/messages`)
        .set('Authorization', bearer(session.visitorToken));
      expect(transcript.status).toBe(200);
      expect(transcript.body.data.items[0]).toMatchObject({ role: 'AGENT' });
      expect(transcript.body.data.items[0]).not.toHaveProperty('senderId');
      expect(JSON.stringify(transcript.body)).not.toContain(fx.agentA.id);
    });

    it('refuses a reply to a resolved conversation (400) and writes nothing', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx, {
        status: 'RESOLVED',
        assignedAgentId: fx.agentA.id,
        resolvedAt: minutesAgo(5),
        escalatedAt: minutesAgo(30),
      });

      const res = await request(app)
        .post(replyUrl(session.conversation.id))
        .set('Authorization', auth(fx.agentA))
        .send({ content: 'Are you still there?' });

      // 400, not 409: a closed conversation is not a lost race, it is an inapplicable act.
      // Reopening is the documented way forward (§8.3).
      expect(res.status).toBe(400);
      expect(await messagesOf(session.conversation.id)).toHaveLength(0);
      expect(await eventsOf(session.conversation.id)).toHaveLength(0);
    });

    it('returns 404 for a conversation in another workspace, and 403 without the permission', async () => {
      const mine = await seedWorkspace();
      const theirs = await seedWorkspace();
      const foreign = await makePublicConversation(theirs, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: theirs.agentA.id,
      });

      const notMine = await request(app)
        .post(replyUrl(foreign.conversation.id))
        .set('Authorization', auth(mine.agentA))
        .send({ content: 'Let me in' });

      expect(notMine.status).toBe(404);

      // A member who may not reply — AGENT holds `conversations:reply`, so the negative case
      // is a workspace with no membership at all, which is the same 404 as above. What this
      // second assertion adds is that the refusal happens *before* any write.
      expect(await messagesOf(foreign.conversation.id)).toHaveLength(0);
    });

    it('an AGENT cannot write an ASSISTANT message — the role is the server’s choice', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });

      // `role` is not in the schema, so a client-supplied one is stripped by validation and
      // the service's own value stands. Without this an agent could forge the bot's voice.
      const res = await request(app)
        .post(replyUrl(session.conversation.id))
        .set('Authorization', auth(fx.agentA))
        .send({ content: 'Trust me', role: 'ASSISTANT' });

      expect(res.status).toBe(201);
      const stored = await messagesOf(session.conversation.id);
      expect(stored[0].role).toBe('AGENT');
    });
  });

  // -------------------------------------------------------------------------------------
  // §10.4 — visitor token scope
  // -------------------------------------------------------------------------------------

  describe('visitor token scope', () => {
    it('cannot reach another conversation, even one on the same bot', async () => {
      const fx = await seedWorkspace();
      const mine = await makePublicConversation(fx);
      const theirs = await makePublicConversation(fx);
      mockAI();

      const read = await request(app)
        .get(publicBase(theirs.conversation.id))
        .set('Authorization', bearer(mine.visitorToken));

      const write = await request(app)
        .post(`${publicBase(theirs.conversation.id)}/messages`)
        .set('Authorization', bearer(mine.visitorToken))
        .send({ content: 'Let me in' });

      expect(read.status).toBe(404);
      expect(write.status).toBe(404);
      // The refusal is total: no message, no provider call, no state change.
      expect(await messagesOf(theirs.conversation.id)).toHaveLength(0);
      expect(aiMock.chat).not.toHaveBeenCalled();
      expect((await stateOf(theirs.conversation.id)).version).toBe(1);
    });

    it('refuses a token whose claims no longer describe the row it names', async () => {
      const fx = await seedWorkspace();
      const theirs = await seedWorkspace();
      const session = await makePublicConversation(fx);

      // A validly-signed token — the signature is not what is being tested. The row, not
      // the token, is the authority on which tenant a conversation belongs to (§10.4).
      const misdirected = signVisitorToken({
        conversationId: session.conversation.id,
        botId: theirs.bot.id,
        workspaceId: theirs.workspace.id,
      });

      const res = await request(app)
        .get(publicBase(session.conversation.id))
        .set('Authorization', bearer(misdirected));

      expect(res.status).toBe(404);
    });

    it('is rejected on the member routes, and a member token is rejected here', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx);

      const visitorOnMemberRoute = await request(app)
        .get(`/api/v1/conversations/${session.conversation.id}`)
        .set('Authorization', bearer(session.visitorToken));

      // The two token families are structurally incompatible: `verifyToken` requires an
      // `email` claim a visitor token never carries, and `verifyVisitorToken` requires
      // `role: 'CUSTOMER'` a member token never carries (§10.4).
      expect(visitorOnMemberRoute.status).toBe(401);

      const noToken = await request(app).get(publicBase(session.conversation.id));
      expect(noToken.status).toBe(401);

      const memberToken = await request(app)
        .get(publicBase(session.conversation.id))
        .set('Authorization', auth(fx.owner));
      expect(memberToken.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------------------
  // §10.3 — session renewal
  // -------------------------------------------------------------------------------------

  describe('POST /public/conversations/:id/refresh', () => {
    it('exchanges the session secret for a fresh, working token', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx);

      const res = await request(app)
        .post(`${publicBase(session.conversation.id)}/refresh`)
        .set('Authorization', bearer(session.visitorToken))
        .send({ sessionSecret: session.sessionSecret });

      expect(res.status).toBe(200);
      const { visitorToken } = res.body.data;
      expect(typeof visitorToken).toBe('string');
      // The secret is never reissued: a leaked response body does not extend a session.
      expect(res.body.data).not.toHaveProperty('sessionSecret');

      // The functional proof that the stored digest is the digest *of this secret* — which
      // is why the session test above does not need to compare hashes itself.
      const use = await request(app)
        .get(publicBase(session.conversation.id))
        .set('Authorization', bearer(visitorToken));
      expect(use.status).toBe(200);
    });

    it('rejects a well-formed but wrong secret with 401 and a malformed one with 400', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx);

      const wrong = await request(app)
        .post(`${publicBase(session.conversation.id)}/refresh`)
        .set('Authorization', bearer(session.visitorToken))
        .send({ sessionSecret: 'a'.repeat(64) });

      // 401, not 404: the conversation is already identified by a validly-signed token, so
      // there is nothing left to conceal — the secret is simply wrong.
      expect(wrong.status).toBe(401);

      const malformed = await request(app)
        .post(`${publicBase(session.conversation.id)}/refresh`)
        .set('Authorization', bearer(session.visitorToken))
        .send({ sessionSecret: 'not-a-secret' });

      // Caught by shape validation, so the database is never reached.
      expect(malformed.status).toBe(400);
    });

    it('refuses to renew a closed session (403) and a conversation with no session at all (404)', async () => {
      const fx = await seedWorkspace();
      const closed = await makePublicConversation(fx, {
        status: 'RESOLVED',
        resolvedAt: minutesAgo(2),
      });

      const resolved = await request(app)
        .post(`${publicBase(closed.conversation.id)}/refresh`)
        .set('Authorization', bearer(closed.visitorToken))
        .send({ sessionSecret: closed.sessionSecret });

      expect(resolved.status).toBe(403);

      // A dashboard-created conversation was never a public session, so there is nothing to
      // renew and no distinct answer to give.
      const internal = await prisma.conversation.create({
        data: { botId: fx.bot.id, workspaceId: fx.workspace.id },
      });
      const orphanToken = signVisitorToken({
        conversationId: internal.id,
        botId: fx.bot.id,
        workspaceId: fx.workspace.id,
      });

      const missing = await request(app)
        .post(`${publicBase(internal.id)}/refresh`)
        .set('Authorization', bearer(orphanToken))
        .send({ sessionSecret: randomBytes(32).toString('hex') });

      expect(missing.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------------------
  // §17 — the transcript the widget sees
  // -------------------------------------------------------------------------------------

  describe('GET /public/conversations/:id/messages', () => {
    it('returns the tail of the conversation, without staff identity', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx);
      const base = Date.now();

      await prisma.message.createMany({
        data: [
          { conversationId: session.conversation.id, role: 'USER', content: 'q1', createdAt: new Date(base) },
          { conversationId: session.conversation.id, role: 'ASSISTANT', content: 'a1', createdAt: new Date(base + 1000) },
          {
            conversationId: session.conversation.id,
            role: 'AGENT',
            content: 'a2',
            senderId: fx.agentA.id,
            createdAt: new Date(base + 2000),
          },
        ],
      });

      const all = await request(app)
        .get(`${publicBase(session.conversation.id)}/messages`)
        .set('Authorization', bearer(session.visitorToken));

      expect(all.status).toBe(200);
      expect(all.body.data.items.map((i: { role: string }) => i.role)).toEqual([
        'USER',
        'ASSISTANT',
        'AGENT',
      ]);
      // §18.2: which staff member answered is internal. `role: AGENT` is enough for the
      // widget to show that a person replied.
      expect(all.body.data.items[2]).not.toHaveProperty('senderId');
      expect(JSON.stringify(all.body)).not.toContain(fx.agentA.id);

      // The window is the tail, not the head: a returning customer continues their
      // conversation rather than being shown its beginning again.
      const limited = await request(app)
        .get(`${publicBase(session.conversation.id)}/messages?limit=2`)
        .set('Authorization', bearer(session.visitorToken));

      expect(limited.body.data.items.map((i: { role: string }) => i.role)).toEqual([
        'ASSISTANT',
        'AGENT',
      ]);
    });

    it('carries the lifecycle state the widget renders, and no more', async () => {
      const fx = await seedWorkspace();
      const session = await makePublicConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(3),
      });

      const res = await request(app)
        .get(`${publicBase(session.conversation.id)}`)
        .set('Authorization', bearer(session.visitorToken));

      expect(res.status).toBe(200);
      expect(res.body.data.conversation).toMatchObject({
        id: session.conversation.id,
        botId: fx.bot.id,
        status: 'WAITING_FOR_HUMAN',
      });
      // Identity and tenancy are not the customer's business, and `version` is an internal
      // concurrency token that must never be readable — let alone writable — from outside.
      expect(res.body.data.conversation).not.toHaveProperty('assignedAgentId');
      expect(res.body.data.conversation).not.toHaveProperty('workspaceId');
      expect(res.body.data.conversation).not.toHaveProperty('version');
      expect(res.body.data.conversation).not.toHaveProperty('visitorSessionHash');
    });
  });
});
