import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

import { config as loadEnv } from 'dotenv';

/**
 * CP2 verification: the support queue and every lifecycle transition, driven over real
 * HTTP against real PostgreSQL.
 *
 * Two deliberate departures from the rest of the suite, both required for this file to
 * prove anything:
 *
 *  1. The real `.env` wins (`override: true`) so `DATABASE_URL` points at Postgres. The
 *     shared setup pins it to an unreachable placeholder. A mocked Prisma cannot
 *     demonstrate that a concurrent claim is race-free — it would only demonstrate that
 *     the mock returns what it was told to.
 *  2. The app is exercised through `supertest` rather than by calling services directly,
 *     so the status codes asserted here are the ones middleware, validation, the service
 *     layer and the error handler produce *together*. "Exact status code assertions" is
 *     the checkpoint's stated acceptance criterion, and 404-vs-403 in particular is
 *     decided by the authorization middleware, not by the service.
 *
 * Fixtures are committed (not rolled back) because an HTTP request runs on a different
 * connection and could not see uncommitted rows. They are removed in `afterEach` by
 * deleting the workspace, which cascades to bots, conversations, messages and events.
 */
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
    '[conversationQueue] PostgreSQL is not reachable — skipping live queue/lifecycle verification. ' +
      'Set DATABASE_URL in app/server/.env to run these tests.'
  );
}

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

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

  return { workspace, bot, owner, admin, agentA, agentB };
};

type Fixture = Awaited<ReturnType<typeof seedWorkspace>>;

interface ConvOptions {
  status?: 'ACTIVE' | 'WAITING_FOR_HUMAN' | 'HUMAN_ACTIVE' | 'RESOLVED';
  assignedAgentId?: string | null;
  escalatedAt?: Date | null;
  resolvedAt?: Date | null;
  escalationReason?: string | null;
  botId?: string;
  preview?: string;
}

const makeConversation = (fx: Fixture, options: ConvOptions = {}) =>
  prisma.conversation.create({
    data: {
      botId: options.botId ?? fx.bot.id,
      workspaceId: fx.workspace.id,
      status: options.status ?? 'ACTIVE',
      assignedAgentId: options.assignedAgentId ?? null,
      escalatedAt: options.escalatedAt ?? null,
      escalationReason: options.escalationReason ?? null,
      resolvedAt: options.resolvedAt ?? null,
      ...(options.preview
        ? { messages: { create: { role: 'USER' as const, content: options.preview } } }
        : {}),
    },
  });

const auth = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

const queueUrl = (workspaceId: string): string =>
  `/api/v1/workspaces/${workspaceId}/conversations/queue`;

const claimUrl = (id: string) => `/api/v1/conversations/${id}/claim`;
const assignUrl = (id: string) => `/api/v1/conversations/${id}/assign`;
const unassignUrl = (id: string) => `/api/v1/conversations/${id}/unassign`;
const resolveUrl = (id: string) => `/api/v1/conversations/${id}/resolve`;
const reopenUrl = (id: string) => `/api/v1/conversations/${id}/reopen`;
const eventsUrl = (id: string) => `/api/v1/conversations/${id}/events`;

const eventsOf = (conversationId: string) =>
  prisma.conversationEvent.findMany({ where: { conversationId } });

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000);

describe.skipIf(!reachable)('Support queue and lifecycle transitions (CP2)', () => {
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
  // Queue listing
  // -------------------------------------------------------------------------------------

  describe('GET /workspaces/:workspaceId/conversations/queue', () => {
    it('lists only escalated-and-unowned conversations, oldest escalation first', async () => {
      const fx = await seedWorkspace();
      const oldest = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(10),
        escalationReason: 'LLM_INSUFFICIENT_INFORMATION',
        preview: 'Where is my order?',
      });
      const newer = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(2),
      });
      // Three rows that must NOT appear in the unassigned tab, one per exclusion reason.
      await makeConversation(fx, { status: 'ACTIVE' });
      await makeConversation(fx, { status: 'HUMAN_ACTIVE', assignedAgentId: fx.agentA.id });
      await makeConversation(fx, { status: 'RESOLVED', resolvedAt: minutesAgo(1) });

      const res = await request(app).get(queueUrl(fx.workspace.id)).set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(200);
      // FIFO by escalation time, not by creation — `newer` was created second *and*
      // escalated second, but the ordering must be driven by escalatedAt.
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual([oldest.id, newer.id]);
      expect(res.body.data.pagination).toEqual({ limit: 25, hasMore: false });
    });

    it('projects a summary, not a transcript, and never leaks contact PII', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
        preview: 'I need a refund',
      });
      await prisma.conversationContact.create({
        data: {
          conversationId: conversation.id,
          email: 'customer@example.test',
          phone: '+15550001111',
        },
      });

      const res = await request(app).get(queueUrl(fx.workspace.id)).set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(200);
      const item = res.body.data.items[0];
      expect(item.id).toBe(conversation.id);
      // §18.2: contact details are fetched for the one conversation an agent opened, never
      // sprayed across a list response.
      expect(item).not.toHaveProperty('contact');
      // The newest message is the preview the inbox row renders.
      expect(item.messages).toHaveLength(1);
      expect(item.messages[0]).toMatchObject({ role: 'USER', content: 'I need a refund' });
      expect(item.bot).toMatchObject({ id: fx.bot.id });
    });

    it('scopes the "assigned" tab to the caller, not to the workspace', async () => {
      const fx = await seedWorkspace();
      const mine = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });
      await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentB.id,
        escalatedAt: minutesAgo(4),
      });

      const res = await request(app)
        .get(`${queueUrl(fx.workspace.id)}?view=assigned`)
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual([mine.id]);
    });

    it('"all_active" spans the queue and the agents, excluding resolved and AI-only work', async () => {
      const fx = await seedWorkspace();
      const waiting = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(9),
      });
      const inProgress = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentB.id,
        escalatedAt: minutesAgo(3),
      });
      await makeConversation(fx, { status: 'ACTIVE' });
      await makeConversation(fx, { status: 'RESOLVED', resolvedAt: minutesAgo(1) });

      const res = await request(app)
        .get(`${queueUrl(fx.workspace.id)}?view=all_active`)
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual([waiting.id, inProgress.id]);
    });

    it('"resolved" tab is most-recently-closed first', async () => {
      const fx = await seedWorkspace();
      const older = await makeConversation(fx, {
        status: 'RESOLVED',
        resolvedAt: minutesAgo(30),
        escalatedAt: minutesAgo(60),
      });
      const recent = await makeConversation(fx, {
        status: 'RESOLVED',
        resolvedAt: minutesAgo(2),
        escalatedAt: minutesAgo(50),
      });
      await makeConversation(fx, { status: 'WAITING_FOR_HUMAN', escalatedAt: minutesAgo(5) });

      const res = await request(app)
        .get(`${queueUrl(fx.workspace.id)}?view=resolved`)
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual([recent.id, older.id]);
    });

    it('never returns another workspace’s conversations', async () => {
      const mine = await seedWorkspace();
      const theirs = await seedWorkspace();

      const visible = await makeConversation(mine, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });
      await makeConversation(theirs, { status: 'WAITING_FOR_HUMAN', escalatedAt: minutesAgo(5) });

      const res = await request(app).get(queueUrl(mine.workspace.id)).set('Authorization', auth(mine.agentA));

      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual([visible.id]);
    });

    it('filters by botId', async () => {
      const fx = await seedWorkspace();
      const otherBot = await prisma.bot.create({
        data: { name: `Bot ${unique()}`, workspaceId: fx.workspace.id },
      });
      await makeConversation(fx, { status: 'WAITING_FOR_HUMAN', escalatedAt: minutesAgo(5) });
      const onOtherBot = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
        botId: otherBot.id,
      });

      const res = await request(app)
        .get(`${queueUrl(fx.workspace.id)}?botId=${otherBot.id}`)
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual([onOtherBot.id]);
    });

    it('reports hasMore without a second count query, and honours the limit', async () => {
      const fx = await seedWorkspace();
      for (let i = 0; i < 3; i += 1) {
        await makeConversation(fx, { status: 'WAITING_FOR_HUMAN', escalatedAt: minutesAgo(10 - i) });
      }

      const limited = await request(app)
        .get(`${queueUrl(fx.workspace.id)}?limit=2`)
        .set('Authorization', auth(fx.agentA));
      expect(limited.status).toBe(200);
      expect(limited.body.data.items).toHaveLength(2);
      expect(limited.body.data.pagination).toEqual({ limit: 2, hasMore: true });

      const all = await request(app)
        .get(`${queueUrl(fx.workspace.id)}?limit=3`)
        .set('Authorization', auth(fx.agentA));
      expect(all.body.data.items).toHaveLength(3);
      // Exactly three rows exist, so the probe row was absent: hasMore must be false, not
      // "true because we asked for exactly as many as there are".
      expect(all.body.data.pagination).toEqual({ limit: 3, hasMore: false });
    });

    it('lets an AGENT read the queue (conversations:view) but rejects an invalid view (400)', async () => {
      const fx = await seedWorkspace();

      const ok = await request(app)
        .get(`${queueUrl(fx.workspace.id)}?view=assigned`)
        .set('Authorization', auth(fx.agentA));
      expect(ok.status).toBe(200);

      const bad = await request(app)
        .get(`${queueUrl(fx.workspace.id)}?view=everything`)
        .set('Authorization', auth(fx.agentA));
      expect(bad.status).toBe(400);
    });

    it('returns 404 — not 403 — for a workspace the caller does not belong to', async () => {
      const mine = await seedWorkspace();
      const theirs = await seedWorkspace();

      const res = await request(app)
        .get(queueUrl(theirs.workspace.id))
        .set('Authorization', auth(mine.agentA));

      // Distinguishing 403 from 404 here would confirm the other tenant exists.
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------------------
  // Claim
  // -------------------------------------------------------------------------------------

  describe('POST /conversations/:id/claim', () => {
    it('moves an unassigned conversation to HUMAN_ACTIVE and records a CLAIMED event', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(claimUrl(conversation.id))
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: conversation.id,
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
      });

      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.status).toBe('HUMAN_ACTIVE');
      expect(after.assignedAgentId).toBe(fx.agentA.id);
      // The OCC token advanced, so an AI turn that read version 1 cannot commit over this.
      expect(after.version).toBe(2);

      const events = await eventsOf(conversation.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: 'CLAIMED', actorId: fx.agentA.id });
    });

    it('is race-free: two simultaneous claims yield exactly one 200 and one 409', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      const [first, second] = await Promise.all([
        request(app).post(claimUrl(conversation.id)).set('Authorization', auth(fx.agentA)),
        request(app).post(claimUrl(conversation.id)).set('Authorization', auth(fx.agentB)),
      ]);

      // The precondition lives in the UPDATE's WHERE clause, so the loser matches zero rows
      // rather than overwriting the winner — no read-then-write window exists to lose.
      expect([first.status, second.status].sort()).toEqual([200, 409]);

      const winner = first.status === 200 ? fx.agentA : fx.agentB;
      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.status).toBe('HUMAN_ACTIVE');
      expect(after.assignedAgentId).toBe(winner.id);
      // Exactly one assignment, and exactly one version bump: the losing request left no
      // trace at all, which is the observable form of "state and audit commit atomically".
      expect(after.version).toBe(2);

      const claims = (await eventsOf(conversation.id)).filter((e) => e.eventType === 'CLAIMED');
      expect(claims).toHaveLength(1);
      expect(claims[0].actorId).toBe(winner.id);
    });

    it('returns 409 when the conversation is already owned by another agent', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(claimUrl(conversation.id))
        .set('Authorization', auth(fx.agentB));

      expect(res.status).toBe(409);
      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.assignedAgentId).toBe(fx.agentA.id);
      expect(after.version).toBe(1);
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });

    it('returns 409 for a conversation that never left the AI (ACTIVE is not claimable)', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, { status: 'ACTIVE' });

      const res = await request(app)
        .post(claimUrl(conversation.id))
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(409);
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });

    it('returns 400 when claiming a resolved conversation', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'RESOLVED',
        resolvedAt: minutesAgo(5),
        escalatedAt: minutesAgo(30),
      });

      const res = await request(app)
        .post(claimUrl(conversation.id))
        .set('Authorization', auth(fx.agentA));

      // 400, not 409: a closed conversation is not a lost race, it is an inapplicable act.
      expect(res.status).toBe(400);
    });

    it('returns 404 for a conversation in another workspace', async () => {
      const mine = await seedWorkspace();
      const theirs = await seedWorkspace();
      const conversation = await makeConversation(theirs, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(claimUrl(conversation.id))
        .set('Authorization', auth(mine.agentA));

      expect(res.status).toBe(404);
      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.status).toBe('WAITING_FOR_HUMAN');
    });
  });

  // -------------------------------------------------------------------------------------
  // Assign
  // -------------------------------------------------------------------------------------

  describe('POST /conversations/:id/assign', () => {
    it('lets an ADMIN put a queued conversation on an agent and records ASSIGNED', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(assignUrl(conversation.id))
        .set('Authorization', auth(fx.admin))
        .send({ agentId: fx.agentA.id });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'HUMAN_ACTIVE', assignedAgentId: fx.agentA.id });

      const events = await eventsOf(conversation.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: 'ASSIGNED', actorId: fx.admin.id });
      expect(events[0].metadata).toMatchObject({ previousAgentId: null, targetAgentId: fx.agentA.id });
    });

    it('records REASSIGNED — never a second ASSIGNED — when moving an owned ticket', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(assignUrl(conversation.id))
        .set('Authorization', auth(fx.admin))
        .send({ agentId: fx.agentB.id });

      expect(res.status).toBe(200);
      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      // "At most one assigned agent" is a column, so a reassignment replaces rather than adds.
      expect(after.assignedAgentId).toBe(fx.agentB.id);
      expect(after.version).toBe(2);

      const events = await eventsOf(conversation.id);
      expect(events.map((e) => e.eventType)).toEqual(['REASSIGNED']);
      expect(events[0].metadata).toMatchObject({
        previousAgentId: fx.agentA.id,
        targetAgentId: fx.agentB.id,
      });
    });

    it('rejects assignment to a real user who is not a member of this workspace (400)', async () => {
      const fx = await seedWorkspace();
      const outsider = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(assignUrl(conversation.id))
        .set('Authorization', auth(fx.admin))
        // The FK alone would accept this user — they exist platform-wide. Only the
        // membership check makes the assignment tenant-safe, which is what this proves.
        .send({ agentId: outsider.agentA.id });

      expect(res.status).toBe(400);
      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.assignedAgentId).toBeNull();
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });

    it('rejects an agentId that does not exist at all (400)', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(assignUrl(conversation.id))
        .set('Authorization', auth(fx.admin))
        .send({ agentId: '00000000-0000-0000-0000-000000000000' });

      expect(res.status).toBe(400);
    });

    it('returns 409 when assigning to the agent who already owns it', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(assignUrl(conversation.id))
        .set('Authorization', auth(fx.admin))
        .send({ agentId: fx.agentA.id });

      expect(res.status).toBe(409);
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });

    it('returns 400 when assigning a resolved conversation', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'RESOLVED',
        resolvedAt: minutesAgo(5),
        escalatedAt: minutesAgo(30),
      });

      const res = await request(app)
        .post(assignUrl(conversation.id))
        .set('Authorization', auth(fx.admin))
        .send({ agentId: fx.agentA.id });

      expect(res.status).toBe(400);
    });

    it('refuses an AGENT — assignment is conversations:assign, held by OWNER and ADMIN only', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(assignUrl(conversation.id))
        .set('Authorization', auth(fx.agentB))
        .send({ agentId: fx.agentA.id });

      // 403, not 404: the caller *is* a member, they simply may not put work on others.
      expect(res.status).toBe(403);
      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.assignedAgentId).toBeNull();
    });

    it('rejects a malformed agentId (400) before any lookup happens', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(assignUrl(conversation.id))
        .set('Authorization', auth(fx.admin))
        .send({ agentId: 'not-a-uuid' });

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------------------
  // Unassign
  // -------------------------------------------------------------------------------------

  describe('POST /conversations/:id/unassign', () => {
    it('lets an agent hand back their own ticket, returning it to the queue', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(unassignUrl(conversation.id))
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'WAITING_FOR_HUMAN', assignedAgentId: null });

      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.status).toBe('WAITING_FOR_HUMAN');
      expect(after.version).toBe(2);

      const events = await eventsOf(conversation.id);
      expect(events.map((e) => e.eventType)).toEqual(['UNASSIGNED']);
      expect(events[0].metadata).toMatchObject({
        previousAgentId: fx.agentA.id,
        reason: 'SELF_UNASSIGNED',
      });

      // The invariant that matters operationally: it is claimable again.
      const queue = await request(app)
        .get(queueUrl(fx.workspace.id))
        .set('Authorization', auth(fx.agentB));
      expect(queue.body.data.items.map((i: { id: string }) => i.id)).toEqual([conversation.id]);
    });

    it('refuses an AGENT taking a ticket off another agent (403)', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(unassignUrl(conversation.id))
        .set('Authorization', auth(fx.agentB));

      expect(res.status).toBe(403);
      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.assignedAgentId).toBe(fx.agentA.id);
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });

    it('lets an ADMIN take a ticket off another agent, recording ADMIN_UNASSIGNED', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(unassignUrl(conversation.id))
        .set('Authorization', auth(fx.admin));

      expect(res.status).toBe(200);
      const events = await eventsOf(conversation.id);
      expect(events[0]).toMatchObject({ eventType: 'UNASSIGNED', actorId: fx.admin.id });
      expect(events[0].metadata).toMatchObject({
        previousAgentId: fx.agentA.id,
        reason: 'ADMIN_UNASSIGNED',
      });
    });

    it('returns 400 for a conversation nobody owns', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(unassignUrl(conversation.id))
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(400);
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------
  // Resolve and reopen
  // -------------------------------------------------------------------------------------

  describe('resolve and reopen', () => {
    it('resolves an owned conversation, stamping resolvedAt and keeping the assignee', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(resolveUrl(conversation.id))
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('RESOLVED');

      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.status).toBe('RESOLVED');
      expect(after.resolvedAt).not.toBeNull();
      // Resolving closes the ticket, it does not erase who handled it — the audit trail
      // and the reopen path both need the owner to still be recorded.
      expect(after.assignedAgentId).toBe(fx.agentA.id);
      expect(after.version).toBe(2);

      const events = await eventsOf(conversation.id);
      expect(events.map((e) => e.eventType)).toEqual(['RESOLVED']);
      expect(events[0].actorId).toBe(fx.agentA.id);
    });

    it('returns 400 when resolving an already-resolved conversation', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'RESOLVED',
        assignedAgentId: fx.agentA.id,
        resolvedAt: minutesAgo(5),
        escalatedAt: minutesAgo(30),
      });

      const res = await request(app)
        .post(resolveUrl(conversation.id))
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(400);
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });

    it('reopens a resolved conversation onto the reopening agent and clears resolvedAt', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'RESOLVED',
        assignedAgentId: fx.agentA.id,
        resolvedAt: minutesAgo(5),
        escalatedAt: minutesAgo(30),
      });

      const res = await request(app)
        .post(reopenUrl(conversation.id))
        .set('Authorization', auth(fx.agentB));

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'HUMAN_ACTIVE', assignedAgentId: fx.agentB.id });

      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.status).toBe('HUMAN_ACTIVE');
      expect(after.resolvedAt).toBeNull();
      // Reopening hands the ticket to whoever reopened it, so it can never be left
      // HUMAN_ACTIVE with a null agent — the invariant the FK's SetNull alone would break.
      expect(after.assignedAgentId).toBe(fx.agentB.id);

      const events = await eventsOf(conversation.id);
      expect(events.map((e) => e.eventType)).toEqual(['REOPENED']);
      expect(events[0].metadata).toMatchObject({ actor: 'AGENT', previousStatus: 'RESOLVED' });
    });

    it('returns 400 when reopening a conversation that is not resolved', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .post(reopenUrl(conversation.id))
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(400);
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------------------

  describe('GET /conversations/:id/events', () => {
    it('returns the lifecycle history newest-first, with the acting user', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      await request(app).post(claimUrl(conversation.id)).set('Authorization', auth(fx.agentA));
      await request(app).post(resolveUrl(conversation.id)).set('Authorization', auth(fx.agentA));

      const res = await request(app)
        .get(eventsUrl(conversation.id))
        .set('Authorization', auth(fx.agentA));

      expect(res.status).toBe(200);
      expect(res.body.data.items.map((e: { eventType: string }) => e.eventType)).toEqual([
        'RESOLVED',
        'CLAIMED',
      ]);
      expect(res.body.data.items[0].actor).toMatchObject({ id: fx.agentA.id });
    });

    it('returns 404 for a conversation in another workspace', async () => {
      const mine = await seedWorkspace();
      const theirs = await seedWorkspace();
      const conversation = await makeConversation(theirs, {
        status: 'WAITING_FOR_HUMAN',
        escalatedAt: minutesAgo(5),
      });

      const res = await request(app)
        .get(eventsUrl(conversation.id))
        .set('Authorization', auth(mine.agentA));

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------------------
  // Membership revocation
  // -------------------------------------------------------------------------------------

  describe('membership revocation', () => {
    it('re-queues a removed agent’s tickets in the same transaction, with an audit event', async () => {
      const fx = await seedWorkspace();
      const conversation = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });
      const membership = await prisma.workspaceMember.findUniqueOrThrow({
        where: { userId_workspaceId: { userId: fx.agentA.id, workspaceId: fx.workspace.id } },
      });

      const res = await request(app)
        .delete(`/api/v1/workspaces/${fx.workspace.id}/members/${membership.id}`)
        .set('Authorization', auth(fx.owner));

      expect(res.status).toBe(200);

      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      // Left HUMAN_ACTIVE with a null agent, this ticket would be invisible in every tab:
      // not in the unassigned queue (it has a status mismatch) and not in anyone's
      // assigned list. Re-queueing is what keeps it workable.
      expect(after.status).toBe('WAITING_FOR_HUMAN');
      expect(after.assignedAgentId).toBeNull();
      expect(after.version).toBe(2);

      const events = await eventsOf(conversation.id);
      expect(events.map((e) => e.eventType)).toEqual(['UNASSIGNED']);
      expect(events[0].metadata).toMatchObject({
        reason: 'MEMBERSHIP_REVOKED',
        previousAgentId: fx.agentA.id,
      });

      // And the proof it is genuinely back in the pool for someone else.
      const queue = await request(app)
        .get(queueUrl(fx.workspace.id))
        .set('Authorization', auth(fx.agentB));
      expect(queue.body.data.items.map((i: { id: string }) => i.id)).toEqual([conversation.id]);
    });

    it('leaves another agent’s tickets untouched', async () => {
      const fx = await seedWorkspace();
      const mine = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentA.id,
        escalatedAt: minutesAgo(5),
      });
      const theirs = await makeConversation(fx, {
        status: 'HUMAN_ACTIVE',
        assignedAgentId: fx.agentB.id,
        escalatedAt: minutesAgo(4),
      });
      const membership = await prisma.workspaceMember.findUniqueOrThrow({
        where: { userId_workspaceId: { userId: fx.agentA.id, workspaceId: fx.workspace.id } },
      });

      await request(app)
        .delete(`/api/v1/workspaces/${fx.workspace.id}/members/${membership.id}`)
        .set('Authorization', auth(fx.owner));

      const untouched = await prisma.conversation.findUniqueOrThrow({ where: { id: theirs.id } });
      expect(untouched.status).toBe('HUMAN_ACTIVE');
      expect(untouched.assignedAgentId).toBe(fx.agentB.id);
      expect(untouched.version).toBe(1);

      const requeued = await prisma.conversation.findUniqueOrThrow({ where: { id: mine.id } });
      expect(requeued.status).toBe('WAITING_FOR_HUMAN');
    });
  });
});
