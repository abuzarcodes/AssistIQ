import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { config as loadEnv } from 'dotenv';

/**
 * CP7 Concurrency, Escalation Race Conditions, and OCC Test Suite (§9, §11, §13, CP7).
 *
 * Verifies the core concurrency invariants under simultaneous requests against real PostgreSQL:
 *   1. AI Generation Starting Before Escalation & Finishing After (Invariant #4):
 *      When a conversation transitions to WAITING_FOR_HUMAN or HUMAN_ACTIVE while an AI turn
 *      is in flight, the completed AI response is discarded by the optimistic conditional
 *      commit (OCC). No ASSISTANT message is written; the ticket remains escalated/claimed.
 *   2. Concurrent Claims on Unassigned Ticket (Invariant #3):
 *      When two or more agents simultaneously claim an unassigned ticket, the atomic UPDATE
 *      with precondition ensures exactly one agent wins (200 OK) and all other contenders
 *      receive clear conflict errors (409 Conflict). Exactly one CLAIMED event is recorded.
 *   3. Concurrent Customer Messages (Invariant #1, #4):
 *      Multiple customer messages dispatched simultaneously are safely committed as USER
 *      messages without database deadlocks, unique constraint failures, or race corruptions.
 *   4. Concurrent Customer Message & Agent Claim:
 *      Customer message arriving while an agent claims bypasses AI safely (pre-flight gate)
 *      and does not collide with the claim's version bump.
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
    '[concurrencyEscalation] PostgreSQL is not reachable — skipping concurrency race tests.'
  );
}

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

let createdWorkspaceIds: string[] = [];
let createdUserIds: string[] = [];

const unique = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const makeUser = async (label: string) => {
  const user = await prisma.user.create({
    data: {
      name: `${label} ${unique()}`,
      email: `${label}-${unique()}@example.test`,
      passwordHash: '$2b$10$abcdefghijklmnopqrstuvwxyz1234567890',
    },
  });
  createdUserIds.push(user.id);
  return user;
};

const seedWorkspace = async () => {
  const owner = await makeUser('owner');
  const workspace = await prisma.workspace.create({
    data: { name: `WS ${unique()}`, ownerId: owner.id },
  });
  createdWorkspaceIds.push(workspace.id);

  const join = (userId: string, role: string) =>
    prisma.workspaceMember.create({ data: { userId, workspaceId: workspace.id, role } });

  await join(owner.id, 'OWNER');
  const agentA = await makeUser('agent-a');
  await join(agentA.id, 'AGENT');
  const agentB = await makeUser('agent-b');
  await join(agentB.id, 'AGENT');
  const agentC = await makeUser('agent-c');
  await join(agentC.id, 'AGENT');

  const bot = await prisma.bot.create({
    data: { name: `Bot ${unique()}`, workspaceId: workspace.id },
  });

  return { workspace, bot, owner, agentA, agentB, agentC };
};

const auth = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

const SUCCESS_AI_REPLY = {
  status: 'success',
  response: 'Here is your automated AI answer.',
  fallback_required: false,
};

describe.skipIf(!reachable)('Concurrency and Escalation Race Conditions (CP7)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterEach(async () => {
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

  describe('1. AI Generation Racing with Concurrent Lifecycle Transition', () => {
    it('discards AI response if conversation is escalated while AI is generating (Invariant #4)', async () => {
      const fx = await seedWorkspace();

      const publicRes = await request(app).post(`/api/v1/public/bots/${fx.bot.id}/conversations`);
      const { conversation, visitorToken } = publicRes.body.data;

      // AI hook: during AI generation, transition the conversation to WAITING_FOR_HUMAN
      aiMock.chat.mockImplementationOnce(async () => {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            status: 'WAITING_FOR_HUMAN',
            escalatedAt: new Date(),
            escalationReason: 'EXPLICIT_HUMAN_REQUEST',
            version: { increment: 1 },
          },
        });
        return SUCCESS_AI_REPLY;
      });

      const sendRes = await request(app)
        .post(`/api/v1/public/conversations/${conversation.id}/messages`)
        .set('Authorization', `Bearer ${visitorToken}`)
        .send({ content: 'I need help please' });

      expect(sendRes.status).toBe(200);
      expect(sendRes.body.data.suppressed).toBe(true);
      expect(sendRes.body.data.suppressionReason).toBe('STALE');
      expect(sendRes.body.data.assistantMessage).toBeNull();

      // State invariant: status remains WAITING_FOR_HUMAN, no ASSISTANT message persisted
      const current = await prisma.conversation.findUnique({ where: { id: conversation.id } });
      expect(current?.status).toBe('WAITING_FOR_HUMAN');

      const messages = await prisma.message.findMany({ where: { conversationId: conversation.id } });
      expect(messages.map((m) => m.role)).toEqual(['USER']);
    });

    it('discards AI response if an agent claims ticket while AI is generating (Invariant #4)', async () => {
      const fx = await seedWorkspace();

      const publicRes = await request(app).post(`/api/v1/public/bots/${fx.bot.id}/conversations`);
      const { conversation, visitorToken } = publicRes.body.data;

      // AI hook: during AI generation, agent claims conversation
      aiMock.chat.mockImplementationOnce(async () => {
        // Move conversation to WAITING_FOR_HUMAN first, then claim
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: {
            status: 'WAITING_FOR_HUMAN',
            escalatedAt: new Date(),
            version: { increment: 1 },
          },
        });

        // Agent claims
        const claimRes = await request(app)
          .post(`/api/v1/conversations/${conversation.id}/claim`)
          .set('Authorization', auth(fx.agentA));
        expect(claimRes.status).toBe(200);

        return SUCCESS_AI_REPLY;
      });

      const sendRes = await request(app)
        .post(`/api/v1/public/conversations/${conversation.id}/messages`)
        .set('Authorization', `Bearer ${visitorToken}`)
        .send({ content: 'Is anyone there?' });

      expect(sendRes.status).toBe(200);
      expect(sendRes.body.data.suppressed).toBe(true);
      expect(sendRes.body.data.assistantMessage).toBeNull();

      // Invariant: conversation remains HUMAN_ACTIVE assigned to agent A
      const current = await prisma.conversation.findUnique({ where: { id: conversation.id } });
      expect(current?.status).toBe('HUMAN_ACTIVE');
      expect(current?.assignedAgentId).toBe(fx.agentA.id);

      const messages = await prisma.message.findMany({ where: { conversationId: conversation.id } });
      expect(messages.map((m) => m.role)).toEqual(['USER']);
    });
  });

  describe('2. Concurrent Atomic Claims (Invariant #3)', () => {
    it('simultaneous claims by 3 agents result in exactly one winner (200) and two losers (409)', async () => {
      const fx = await seedWorkspace();

      const conv = await prisma.conversation.create({
        data: {
          botId: fx.bot.id,
          workspaceId: fx.workspace.id,
          status: 'WAITING_FOR_HUMAN',
          escalatedAt: new Date(),
          version: 1,
        },
      });

      // Fire 3 simultaneous claims
      const [resA, resB, resC] = await Promise.all([
        request(app).post(`/api/v1/conversations/${conv.id}/claim`).set('Authorization', auth(fx.agentA)),
        request(app).post(`/api/v1/conversations/${conv.id}/claim`).set('Authorization', auth(fx.agentB)),
        request(app).post(`/api/v1/conversations/${conv.id}/claim`).set('Authorization', auth(fx.agentC)),
      ]);

      const statuses = [resA.status, resB.status, resC.status];
      const winners = statuses.filter((s) => s === 200);
      const losers = statuses.filter((s) => s === 409);

      expect(winners.length).toBe(1);
      expect(losers.length).toBe(2);

      // Verify conversation has single assignee and HUMAN_ACTIVE status
      const updated = await prisma.conversation.findUnique({ where: { id: conv.id } });
      expect(updated?.status).toBe('HUMAN_ACTIVE');
      expect(updated?.assignedAgentId).not.toBeNull();
      expect([fx.agentA.id, fx.agentB.id, fx.agentC.id]).toContain(updated?.assignedAgentId);
      expect(updated?.version).toBe(2);

      // Verify exactly one CLAIMED audit event exists
      const events = await prisma.conversationEvent.findMany({
        where: { conversationId: conv.id, eventType: 'CLAIMED' },
      });
      expect(events.length).toBe(1);
      expect(events[0].actorId).toBe(updated?.assignedAgentId);
    });
  });

  describe('3. Concurrent Customer Messages and Non-Conflicting Writes', () => {
    it('handles concurrent customer messages safely without deadlocks or errors', async () => {
      const fx = await seedWorkspace();

      const publicRes = await request(app).post(`/api/v1/public/bots/${fx.bot.id}/conversations`);
      const { conversation, visitorToken } = publicRes.body.data;

      aiMock.chat.mockResolvedValue(SUCCESS_AI_REPLY);

      // Dispatch 2 customer messages concurrently
      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/v1/public/conversations/${conversation.id}/messages`)
          .set('Authorization', `Bearer ${visitorToken}`)
          .send({ content: 'Message 1' }),
        request(app)
          .post(`/api/v1/public/conversations/${conversation.id}/messages`)
          .set('Authorization', `Bearer ${visitorToken}`)
          .send({ content: 'Message 2' }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Verify both user messages committed to database
      const userMessages = await prisma.message.findMany({
        where: { conversationId: conversation.id, role: 'USER' },
        orderBy: { createdAt: 'asc' },
      });

      expect(userMessages.length).toBe(2);
      expect(userMessages.map((m) => m.content)).toEqual(
        expect.arrayContaining(['Message 1', 'Message 2'])
      );
    });

    it('customer message arriving during agent claim bypasses AI cleanly', async () => {
      const fx = await seedWorkspace();

      const conv = await prisma.conversation.create({
        data: {
          botId: fx.bot.id,
          workspaceId: fx.workspace.id,
          status: 'WAITING_FOR_HUMAN',
          escalatedAt: new Date(),
          version: 1,
        },
      });

      const { signVisitorToken } = await import('../src/utils/jwt.js');
      const visitorToken = signVisitorToken({
        conversationId: conv.id,
        botId: fx.bot.id,
        workspaceId: fx.workspace.id,
      });

      // Claim and customer message concurrently
      const [claimRes, msgRes] = await Promise.all([
        request(app)
          .post(`/api/v1/conversations/${conv.id}/claim`)
          .set('Authorization', auth(fx.agentA)),
        request(app)
          .post(`/api/v1/public/conversations/${conv.id}/messages`)
          .set('Authorization', `Bearer ${visitorToken}`)
          .send({ content: 'Still waiting for someone' }),
      ]);

      expect(claimRes.status).toBe(200);
      expect(msgRes.status).toBe(200);

      // Message bypassed AI because status was WAITING_FOR_HUMAN / HUMAN_ACTIVE
      expect(msgRes.body.data.suppressed).toBe(true);

      const after = await prisma.conversation.findUnique({ where: { id: conv.id } });
      expect(after?.status).toBe('HUMAN_ACTIVE');
      expect(after?.assignedAgentId).toBe(fx.agentA.id);
    });
  });
});
