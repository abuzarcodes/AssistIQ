import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { config as loadEnv } from 'dotenv';

/**
 * CP7 Security, Multi-Tenancy, and Isolation Regression Suite (§18.1, §10, CP7).
 *
 * Verifies the foundational security invariants of AssistIQ against real PostgreSQL:
 *   1. Cross-Tenant Isolation (Invariant #8): A member in Workspace A can never view,
 *      claim, assign, reply to, or resolve conversations in Workspace B. Foreign tenant
 *      resources return 404 Not Found to prevent existence discovery.
 *   2. Assignment Membership Integrity (Invariant #2, #8): An administrator cannot assign
 *      a conversation to a user who is not an active member of that workspace (400 Bad Request).
 *   3. Visitor Credential Scoping (Invariant #9, #10): Visitor tokens authorize only the
 *      intended conversation and bot. Token tampering, signature alteration, token swapping,
 *      or invalid refresh secrets are rejected with 401/403.
 *   4. Membership Revocation Re-queueing (Invariant #2, §11.3): Deleting a workspace member
 *      atomically releases all their active assigned tickets back to WAITING_FOR_HUMAN and
 *      creates UNASSIGNED audit events.
 */

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
    '[securityIsolation] PostgreSQL is not reachable — skipping security isolation tests.'
  );
}

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');
const { env } = await import('../src/config/env.js');

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

  const ownerMember = await join(owner.id, 'OWNER');
  const admin = await makeUser('admin');
  const adminMember = await join(admin.id, 'ADMIN');
  const agent = await makeUser('agent');
  const agentMember = await join(agent.id, 'AGENT');

  const bot = await prisma.bot.create({
    data: { name: `Bot ${unique()}`, workspaceId: workspace.id },
  });

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

  return { workspace, bot, owner, admin, agent, ownerMember, adminMember, agentMember };
};

const auth = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

describe.skipIf(!reachable)('Security and Multi-Tenant Isolation Suite (CP7)', () => {
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

  describe('1. Cross-Tenant REST Isolation', () => {
    it('Agent in Workspace A cannot access Workspace B queue (returns 404)', async () => {
      const wsA = await seedWorkspace();
      const wsB = await seedWorkspace();

      const res = await request(app)
        .get(`/api/v1/workspaces/${wsB.workspace.id}/conversations/queue`)
        .set('Authorization', auth(wsA.agent));

      expect(res.status).toBe(404);
    });

    it('Agent in Workspace A cannot read a conversation belonging to Workspace B (returns 404)', async () => {
      const wsA = await seedWorkspace();
      const wsB = await seedWorkspace();

      const convB = await prisma.conversation.create({
        data: {
          botId: wsB.bot.id,
          workspaceId: wsB.workspace.id,
          status: 'WAITING_FOR_HUMAN',
          escalatedAt: new Date(),
        },
      });

      const res = await request(app)
        .get(`/api/v1/conversations/${convB.id}`)
        .set('Authorization', auth(wsA.agent));

      expect(res.status).toBe(404);
    });

    it('Agent in Workspace A cannot claim a conversation in Workspace B (returns 404)', async () => {
      const wsA = await seedWorkspace();
      const wsB = await seedWorkspace();

      const convB = await prisma.conversation.create({
        data: {
          botId: wsB.bot.id,
          workspaceId: wsB.workspace.id,
          status: 'WAITING_FOR_HUMAN',
          escalatedAt: new Date(),
        },
      });

      const res = await request(app)
        .post(`/api/v1/conversations/${convB.id}/claim`)
        .set('Authorization', auth(wsA.agent));

      expect(res.status).toBe(404);

      // Verify conversation B state remains untouched
      const fresh = await prisma.conversation.findUnique({ where: { id: convB.id } });
      expect(fresh?.status).toBe('WAITING_FOR_HUMAN');
      expect(fresh?.assignedAgentId).toBeNull();
    });

    it('Admin in Workspace A cannot assign a conversation in Workspace B (returns 404)', async () => {
      const wsA = await seedWorkspace();
      const wsB = await seedWorkspace();

      const convB = await prisma.conversation.create({
        data: {
          botId: wsB.bot.id,
          workspaceId: wsB.workspace.id,
          status: 'WAITING_FOR_HUMAN',
          escalatedAt: new Date(),
        },
      });

      const res = await request(app)
        .post(`/api/v1/conversations/${convB.id}/assign`)
        .set('Authorization', auth(wsA.admin))
        .send({ agentId: wsA.agent.id });

      expect(res.status).toBe(404);
    });

    it('Admin in Workspace A cannot assign conversation to a user belonging only to Workspace B (returns 400)', async () => {
      const wsA = await seedWorkspace();
      const wsB = await seedWorkspace();

      const convA = await prisma.conversation.create({
        data: {
          botId: wsA.bot.id,
          workspaceId: wsA.workspace.id,
          status: 'WAITING_FOR_HUMAN',
          escalatedAt: new Date(),
        },
      });

      // Target agent is only in Workspace B, not Workspace A
      const res = await request(app)
        .post(`/api/v1/conversations/${convA.id}/assign`)
        .set('Authorization', auth(wsA.admin))
        .send({ agentId: wsB.agent.id });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not a member of this workspace');

      // State unmodified
      const fresh = await prisma.conversation.findUnique({ where: { id: convA.id } });
      expect(fresh?.status).toBe('WAITING_FOR_HUMAN');
      expect(fresh?.assignedAgentId).toBeNull();
    });

    it('Agent in Workspace A cannot reply to, resolve, or inspect events of Workspace B conversation (all return 404)', async () => {
      const wsA = await seedWorkspace();
      const wsB = await seedWorkspace();

      const convB = await prisma.conversation.create({
        data: {
          botId: wsB.bot.id,
          workspaceId: wsB.workspace.id,
          status: 'HUMAN_ACTIVE',
          assignedAgentId: wsB.agent.id,
        },
      });

      // Reply
      const replyRes = await request(app)
        .post(`/api/v1/conversations/${convB.id}/reply`)
        .set('Authorization', auth(wsA.agent))
        .send({ content: 'Cross-tenant trespass attempt' });
      expect(replyRes.status).toBe(404);

      // Resolve
      const resolveRes = await request(app)
        .post(`/api/v1/conversations/${convB.id}/resolve`)
        .set('Authorization', auth(wsA.agent));
      expect(resolveRes.status).toBe(404);

      // Events
      const eventsRes = await request(app)
        .get(`/api/v1/conversations/${convB.id}/events`)
        .set('Authorization', auth(wsA.agent));
      expect(eventsRes.status).toBe(404);

      // Messages cursor
      const messagesRes = await request(app)
        .get(`/api/v1/conversations/${convB.id}/messages`)
        .set('Authorization', auth(wsA.agent));
      expect(messagesRes.status).toBe(404);
    });
  });

  describe('2. Public Visitor Token Tampering and Scope Protection', () => {
    it('rejects tampered visitor token signature with 401', async () => {
      const fx = await seedWorkspace();

      const createRes = await request(app)
        .post(`/api/v1/public/bots/${fx.bot.id}/conversations`);
      expect(createRes.status).toBe(201);

      const { conversation, visitorToken } = createRes.body.data;

      // Tamper signature
      const tamperedToken = visitorToken.slice(0, -6) + 'xxxxxx';

      const res = await request(app)
        .get(`/api/v1/public/conversations/${conversation.id}`)
        .set('Authorization', `Bearer ${tamperedToken}`);

      expect(res.status).toBe(401);
    });

    it('rejects visitor token signed with foreign secret with 401', async () => {
      const fx = await seedWorkspace();

      const createRes = await request(app)
        .post(`/api/v1/public/bots/${fx.bot.id}/conversations`);
      expect(createRes.status).toBe(201);

      const { conversation } = createRes.body.data;

      const rogueToken = jwt.sign(
        {
          sub: `visitor:${conversation.id}`,
          conversationId: conversation.id,
          botId: fx.bot.id,
          workspaceId: fx.workspace.id,
          role: 'CUSTOMER',
        },
        'rogue-secret-different-from-server-jwt-secret',
        { expiresIn: '15m' }
      );

      const res = await request(app)
        .get(`/api/v1/public/conversations/${conversation.id}`)
        .set('Authorization', `Bearer ${rogueToken}`);

      expect(res.status).toBe(401);
    });

    it('rejects swapped visitor token accessing another conversation with 403 or 404', async () => {
      const fx = await seedWorkspace();

      // Create conversation 1
      const res1 = await request(app).post(`/api/v1/public/bots/${fx.bot.id}/conversations`);
      const { conversation: conv1, visitorToken: token1 } = res1.body.data;

      // Create conversation 2
      const res2 = await request(app).post(`/api/v1/public/bots/${fx.bot.id}/conversations`);
      const { conversation: conv2 } = res2.body.data;

      // Attempt to access conversation 2 using token 1
      const snoopRes = await request(app)
        .get(`/api/v1/public/conversations/${conv2.id}`)
        .set('Authorization', `Bearer ${token1}`);

      // Token claims conversationId != URL param conversationId
      expect([403, 404]).toContain(snoopRes.status);

      // Attempt to send message to conversation 2 using token 1
      const msgRes = await request(app)
        .post(`/api/v1/public/conversations/${conv2.id}/messages`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ content: 'Snooping attempt' });

      expect([403, 404]).toContain(msgRes.status);
    });

    it('rejects token refresh with invalid session secret with 401, and malformed with 400', async () => {
      const fx = await seedWorkspace();

      const createRes = await request(app).post(`/api/v1/public/bots/${fx.bot.id}/conversations`);
      const { conversation, visitorToken } = createRes.body.data;

      // Malformed shape (not 64 hex chars) -> 400 ValidationError
      const malformedRes = await request(app)
        .post(`/api/v1/public/conversations/${conversation.id}/refresh`)
        .set('Authorization', `Bearer ${visitorToken}`)
        .send({ sessionSecret: 'not-a-64-hex-secret' });

      expect(malformedRes.status).toBe(400);

      // Well-formed 64-hex string, but wrong secret -> 401 AuthenticationError
      const wrongSecretRes = await request(app)
        .post(`/api/v1/public/conversations/${conversation.id}/refresh`)
        .set('Authorization', `Bearer ${visitorToken}`)
        .send({ sessionSecret: 'a'.repeat(64) });

      expect(wrongSecretRes.status).toBe(401);
    });
  });

  describe('3. Membership Revocation Re-queueing (§11.3)', () => {
    it('revoking an assigned agent atomically releases active tickets back to WAITING_FOR_HUMAN', async () => {
      const fx = await seedWorkspace();

      // Create conversation assigned to agent
      const conv = await prisma.conversation.create({
        data: {
          botId: fx.bot.id,
          workspaceId: fx.workspace.id,
          status: 'HUMAN_ACTIVE',
          assignedAgentId: fx.agent.id,
          version: 1,
        },
      });

      // Revoke agent's membership via DELETE /workspaces/:workspaceId/members/:memberId
      const deleteRes = await request(app)
        .delete(`/api/v1/workspaces/${fx.workspace.id}/members/${fx.agentMember.id}`)
        .set('Authorization', auth(fx.owner));

      expect(deleteRes.status).toBe(200);

      // Verify conversation transitioned to WAITING_FOR_HUMAN and unassigned
      const updated = await prisma.conversation.findUnique({ where: { id: conv.id } });
      expect(updated?.status).toBe('WAITING_FOR_HUMAN');
      expect(updated?.assignedAgentId).toBeNull();
      expect(updated?.version).toBe(2);

      // Verify UNASSIGNED event was committed
      const events = await prisma.conversationEvent.findMany({
        where: { conversationId: conv.id, eventType: 'UNASSIGNED' },
      });
      expect(events.length).toBe(1);

      // Verify revoked agent now receives 404 when querying workspace queue
      const queueRes = await request(app)
        .get(`/api/v1/workspaces/${fx.workspace.id}/conversations/queue`)
        .set('Authorization', auth(fx.agent));
      expect(queueRes.status).toBe(404);
    });
  });
});
