import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { config as loadEnv } from 'dotenv';

// The shared test setup (`tests/setup.ts`) pins DATABASE_URL to a deliberately
// unreachable placeholder so the rest of the suite stays hermetic and never touches a
// real database. This file is the single deliberate exception: its entire purpose is to
// prove that migration `add_human_escalation` really landed in PostgreSQL and that the
// generated client can work with what it created. Mocking Prisma here would verify
// nothing at all, so the real .env wins and the file skips itself if no DB answers.
loadEnv({ path: new URL('../.env', import.meta.url), override: true });

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();

/** The migration must be present on disk, whatever the database says. */
const migrationSql = readFileSync(
  new URL('../prisma/migrations/20261011190000_add_human_escalation/migration.sql', import.meta.url),
  'utf8'
);

const reachable = await prisma
  .$queryRaw`SELECT 1`
  .then(() => true)
  .catch(() => false);

if (!reachable) {
  console.warn(
    '[schemaEscalation] PostgreSQL is not reachable — skipping live schema verification. ' +
      'Set DATABASE_URL in app/server/.env to run these tests.'
  );
}

/**
 * Every test writes inside one interactive transaction that is rolled back at the end,
 * so the developer's database is left exactly as it was found. The rollback is driven by
 * throwing a sentinel that the caller swallows.
 */
class Rollback extends Error {}

const inRolledBackTransaction = async <T>(
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>
): Promise<T> => {
  let captured: T | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      captured = await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return captured as T;
};

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Minimal valid fixture graph: owner -> workspace -> bot, plus a separate support agent
 * who is a plain member.
 *
 * The owner and the agent are deliberately different users. `Workspace.owner` is
 * `onDelete: Cascade`, so deleting a workspace's owner destroys the workspace and every
 * conversation in it — which would mask the `assignedAgent` foreign key's own `SetNull`
 * behaviour and make an assignment test pass for the wrong reason.
 */
const seedFixture = async (tx: any) => {
  const suffix = unique();
  const owner = await tx.user.create({
    data: { name: 'Owner', email: `owner-${suffix}@example.test`, passwordHash: 'x' },
  });
  const workspace = await tx.workspace.create({
    data: { name: 'Support', ownerId: owner.id },
  });
  await tx.workspaceMember.create({
    data: { userId: owner.id, workspaceId: workspace.id, role: 'OWNER' },
  });

  const agent = await tx.user.create({
    data: { name: 'Agent', email: `agent-${suffix}@example.test`, passwordHash: 'x' },
  });
  await tx.workspaceMember.create({
    data: { userId: agent.id, workspaceId: workspace.id, role: 'AGENT' },
  });

  const bot = await tx.bot.create({
    data: { name: 'Bot', workspaceId: workspace.id },
  });
  return { owner, agent, workspace, bot };
};

describe.skipIf(!reachable)('Schema: human escalation, assignment, and audit (CP1)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('supports the HUMAN_ACTIVE lifecycle state with an assigned agent', async () => {
    const result = await inRolledBackTransaction(async (tx) => {
      const { agent, workspace, bot } = await seedFixture(tx);

      const conversation = await tx.conversation.create({
        data: {
          botId: bot.id,
          workspaceId: workspace.id,
          status: 'HUMAN_ACTIVE',
          assignedAgentId: agent.id,
        },
        include: { assignedAgent: true },
      });

      // Denormalised workspaceId must be readable straight off the row: every queue and
      // tenant-isolation query filters on it without joining through `bot`.
      expect(conversation.workspaceId).toBe(workspace.id);
      expect(conversation.status).toBe('HUMAN_ACTIVE');
      expect(conversation.assignedAgent?.id).toBe(agent.id);
      // OCC token starts at 1 for every row the migration backfilled and every new row.
      expect(conversation.version).toBe(1);
      expect(conversation.resolvedAt).toBeNull();
      expect(conversation.visitorSessionHash).toBeNull();

      return conversation.id;
    });

    expect(result).toBeTruthy();
  });

  it('creates AGENT messages carrying the author, and stores clientMessageId', async () => {
    const result = await inRolledBackTransaction(async (tx) => {
      const { agent, workspace, bot } = await seedFixture(tx);
      const conversation = await tx.conversation.create({
        data: { botId: bot.id, workspaceId: workspace.id },
      });

      const message = await tx.message.create({
        data: {
          conversationId: conversation.id,
          role: 'AGENT',
          content: 'Hi, I am taking over from here.',
          senderId: agent.id,
          clientMessageId: 'client-key-123',
        },
        include: { sender: true },
      });

      expect(message.role).toBe('AGENT');
      expect(message.sender?.id).toBe(agent.id);
      expect(message.clientMessageId).toBe('client-key-123');

      // Customer and assistant messages carry no author — the column is genuinely optional.
      const customerMessage = await tx.message.create({
        data: { conversationId: conversation.id, role: 'USER', content: 'Thanks!' },
      });
      expect(customerMessage.senderId).toBeNull();

      return message.id;
    });

    expect(result).toBeTruthy();
  });

  it('inserts ConversationEvent rows with typed events and JSON metadata', async () => {
    const result = await inRolledBackTransaction(async (tx) => {
      const { agent, workspace, bot } = await seedFixture(tx);
      const conversation = await tx.conversation.create({
        data: { botId: bot.id, workspaceId: workspace.id },
      });

      const escalated = await tx.conversationEvent.create({
        data: {
          conversationId: conversation.id,
          eventType: 'ESCALATED',
          metadata: { reason: 'LLM_INSUFFICIENT_INFORMATION', offHours: false },
        },
      });
      const claimed = await tx.conversationEvent.create({
        data: { conversationId: conversation.id, actorId: agent.id, eventType: 'CLAIMED' },
        include: { actor: true },
      });

      expect(escalated.eventType).toBe('ESCALATED');
      expect(escalated.actorId).toBeNull();
      expect(escalated.metadata).toMatchObject({ reason: 'LLM_INSUFFICIENT_INFORMATION' });
      // A system transition has no actor; a human one does.
      expect(claimed.actor?.id).toBe(agent.id);

      const history = await tx.conversationEvent.findMany({
        where: { conversationId: conversation.id },
      });
      expect(history).toHaveLength(2);

      return history.length;
    });

    expect(result).toBe(2);
  });

  it('enforces tenant integrity: workspaceId must reference a real workspace', async () => {
    await expect(
      inRolledBackTransaction(async (tx) => {
        const { bot } = await seedFixture(tx);
        return tx.conversation.create({
          data: { botId: bot.id, workspaceId: '00000000-0000-0000-0000-000000000000' },
        });
      })
    ).rejects.toThrow();
  });

  it('clears the assignment when the assigned agent is deleted (FK is SetNull, not Cascade)', async () => {
    const result = await inRolledBackTransaction(async (tx) => {
      const { agent, workspace, bot } = await seedFixture(tx);
      const conversation = await tx.conversation.create({
        data: {
          botId: bot.id,
          workspaceId: workspace.id,
          status: 'HUMAN_ACTIVE',
          assignedAgentId: agent.id,
        },
      });

      await tx.user.delete({ where: { id: agent.id } });

      const after = await tx.conversation.findUnique({ where: { id: conversation.id } });
      // The ticket must survive its agent: a deleted account can never take the
      // conversation's history with it. Re-queueing it is the service layer's job (CP2).
      expect(after).not.toBeNull();
      expect(after?.assignedAgentId).toBeNull();
      // The state itself is untouched by the FK: this is a data-integrity guarantee, not
      // a lifecycle transition. Nothing at the database level re-queues the ticket, which
      // is exactly why CP2 owns membership-revocation cleanup.
      expect(after?.status).toBe('HUMAN_ACTIVE');

      return after?.id;
    });

    expect(result).toBeTruthy();
  });

  it('cascades events and messages when the conversation is deleted', async () => {
    const result = await inRolledBackTransaction(async (tx) => {
      const { workspace, bot } = await seedFixture(tx);
      const conversation = await tx.conversation.create({
        data: { botId: bot.id, workspaceId: workspace.id },
      });
      await tx.message.create({
        data: { conversationId: conversation.id, role: 'USER', content: 'hello' },
      });
      await tx.conversationEvent.create({
        data: { conversationId: conversation.id, eventType: 'RESOLVED' },
      });

      await tx.conversation.delete({ where: { id: conversation.id } });

      return {
        messages: await tx.message.count({ where: { conversationId: conversation.id } }),
        events: await tx.conversationEvent.count({ where: { conversationId: conversation.id } }),
      };
    });

    expect(result).toEqual({ messages: 0, events: 0 });
  });

  it('bumps version explicitly, so an in-flight AI turn can detect a lost race', async () => {
    const result = await inRolledBackTransaction(async (tx) => {
      const { workspace, bot } = await seedFixture(tx);
      const conversation = await tx.conversation.create({
        data: { botId: bot.id, workspaceId: workspace.id },
      });

      const updated = await tx.conversation.update({
        where: { id: conversation.id },
        data: { version: { increment: 1 } },
      });

      return { before: conversation.version, after: updated.version };
    });

    expect(result).toEqual({ before: 1, after: 2 });
  });
});

/**
 * Runs even without a database. These assertions read the migration and schema text, so
 * they still hold in a hermetic CI run where the live tests above are skipped.
 */
describe('Schema: migration and model declarations (CP1)', () => {
  it('declares the new lifecycle and audit types in the schema', () => {
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

    expect(schema).toMatch(/enum ConversationStatus \{[\s\S]*?\bHUMAN_ACTIVE\b[\s\S]*?\n\}/);
    expect(schema).toMatch(/enum MessageRole \{[\s\S]*?\bAGENT\b[\s\S]*?\n\}/);
    expect(schema).toMatch(/model ConversationEvent \{/);
    expect(schema).toMatch(/\beventType\s+ConversationEventType/);
  });

  it('declares the columns the escalation feature depends on', () => {
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const conversation = /model Conversation \{([\s\S]*?)\n\}/.exec(schema)?.[1];
    const message = /model Message \{([\s\S]*?)\n\}/.exec(schema)?.[1];

    expect(conversation).toMatch(/\bworkspaceId\s+String\b/);
    expect(conversation).toMatch(/\bversion\s+Int\s+@default\(1\)/);
    expect(conversation).toMatch(/\bresolvedAt\s+DateTime\?/);
    expect(conversation).toMatch(/\bvisitorSessionHash\s+String\?/);
    expect(conversation).toMatch(/\bassignedAgent\s+User\?/);
    expect(message).toMatch(/\bsenderId\s+String\?/);
    expect(message).toMatch(/\bclientMessageId\s+String\?/);
  });

  it('backfills workspaceId before making it NOT NULL, rather than adding a required column outright', () => {
    // The migration cannot simply "ADD COLUMN workspaceId TEXT NOT NULL": the table has
    // rows. This asserts the additive-then-guarded shape actually shipped, because a
    // regression here fails at deploy time on the developer's own database.
    const addColumn = migrationSql.indexOf('ADD COLUMN     "workspaceId" TEXT;');
    const backfill = migrationSql.indexOf('SET "workspaceId" = b."workspaceId"');
    const setNotNull = migrationSql.indexOf('ALTER COLUMN "workspaceId" SET NOT NULL');

    expect(addColumn).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(addColumn);
    expect(setNotNull).toBeGreaterThan(backfill);
    // The guard must precede the constraint, so an unresolvable row aborts the migration
    // instead of surfacing as a NOT NULL violation with no explanation.
    expect(migrationSql).toContain('RAISE EXCEPTION');
  });
});
