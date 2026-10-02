import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn() },
  workspaceMember: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  workspace: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  bot: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  knowledgeEntry: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  conversation: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  message: { create: vi.fn() },
}));

// The AI boundary is mocked so no Python service is required (spec §15, §24).
const aiMock = vi.hoisted(() => ({ chat: vi.fn() }));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const USER_A = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', email: 'b@example.com' };
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

const botBelongsToWorkspace = () => prismaMock.bot.findUnique.mockResolvedValue({ workspaceId: WORKSPACE_ID });

/**
 * The bot has no model assigned — the platform-default path (Checkpoint 6).
 *
 * `addMessage` now resolves the bot's model before calling the AI service, and that
 * resolution is its own `bot.findUnique`. Priming it here keeps these tests exercising what
 * they were written to exercise; left unprimed, the resolver reports "bot row not found" and
 * every one of them would silently take the short-circuit path instead — passing or failing
 * for reasons unrelated to the assertions they make.
 *
 * `aiModelId: null` is the state these tests have always described: a bot on the platform
 * default, sending the same payload it sent before the resolver existed.
 */
const botHasNoModel = () =>
  prismaMock.bot.findUnique.mockResolvedValue({ aiModelId: null, aiModel: null });

const conversationBelongsToWorkspace = () =>
  prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });

const membership = (userId: string, role: 'OWNER' | 'ADMIN' | 'AGENT') =>
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'member-1',
    userId,
    workspaceId: WORKSPACE_ID,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/bots/:botId/conversations', () => {
  it('creates a conversation when the caller may view conversations (201)', async () => {
    botBelongsToWorkspace();
    membership(USER_A.id, 'OWNER');
    // The service re-asserts access to the bot (defence in depth) after the middleware.
    prismaMock.bot.findFirst.mockResolvedValue({
      id: BOT_ID,
      name: 'Helper',
      description: null,
      workspaceId: WORKSPACE_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prismaMock.conversation.create.mockResolvedValue({
      id: CONVERSATION_ID,
      botId: BOT_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/v1/bots/${BOT_ID}/conversations`)
      .set('Authorization', authHeader(USER_A));

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(CONVERSATION_ID);
    expect(prismaMock.conversation.create).toHaveBeenCalledWith({ data: { botId: BOT_ID } });
  });
});

describe('POST /api/v1/conversations/:conversationId/messages', () => {
  it('stores the USER message, calls the AI boundary, and stores the ASSISTANT reply (201)', async () => {
    conversationBelongsToWorkspace();
    membership(USER_A.id, 'OWNER');
    prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID });
    botHasNoModel();
    prismaMock.knowledgeEntry.findMany.mockResolvedValue([
      { title: null, category: null, question: 'Hours?', answer: 'Nine to five.' },
    ]);
    // The stored message reflects the role the service asked for.
    prismaMock.message.create.mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: args.data.role === 'USER' ? 'msg-user' : 'msg-assistant',
        conversationId: args.data.conversationId,
        role: args.data.role,
        content: args.data.content,
        createdAt: new Date(),
      })
    );
    aiMock.chat.mockResolvedValue({
      status: 'success',
      response: 'Mock assistant reply',
      fallback_required: false,
      intent: { predicted: 'faq_match', confidence: 0.9 },
    });

    const res = await request(app)
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', authHeader(USER_A))
      .send({ content: 'What are your hours?' });

    expect(res.status).toBe(201);
    expect(res.body.data.userMessage.role).toBe('USER');
    expect(res.body.data.userMessage.content).toBe('What are your hours?');
    expect(res.body.data.assistantMessage.role).toBe('ASSISTANT');
    expect(res.body.data.assistantMessage.content).toBe('Mock assistant reply');
    expect(res.body.data.ai.response).toBe('Mock assistant reply');

    // The AI service was reached through the boundary with the message + bot context.
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
    expect(aiMock.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        bot_id: BOT_ID,
        message: 'What are your hours?',
      })
    );
    // Exactly two messages persisted: the user's and the assistant's.
    expect(prismaMock.message.create).toHaveBeenCalledTimes(2);
  });

  it('an AGENT can reply (conversations:reply) — Checkpoint 7', async () => {
    conversationBelongsToWorkspace();
    membership(USER_B.id, 'AGENT');
    prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID });
    botHasNoModel();
    prismaMock.knowledgeEntry.findMany.mockResolvedValue([]);
    prismaMock.message.create.mockResolvedValue({
      id: 'msg',
      conversationId: CONVERSATION_ID,
      role: 'USER',
      content: 'hi',
      createdAt: new Date(),
    });
    aiMock.chat.mockResolvedValue({
      status: 'success',
      response: 'Hello!',
      fallback_required: false,
    });

    const res = await request(app)
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', authHeader(USER_B))
      .send({ content: 'hi' });

    expect(res.status).toBe(201);
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
  });

  it('a non-member gets 404 and the AI service is never called', async () => {
    conversationBelongsToWorkspace();
    prismaMock.workspaceMember.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', authHeader(USER_B))
      .send({ content: 'Let me in' });

    expect(res.status).toBe(404);
    expect(aiMock.chat).not.toHaveBeenCalled();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('rejects an empty message body (400)', async () => {
    const res = await request(app)
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', authHeader(USER_A))
      .send({ content: '' });

    expect(res.status).toBe(400);
    expect(aiMock.chat).not.toHaveBeenCalled();
  });
});

/**
 * Checkpoint 7 — the agent side of the conversation foundation.
 *
 * The plan's exit criterion is "Agent role functions correctly within current limits":
 * an AGENT may reply, and must not be able to assign. The permission matrix already
 * encodes that (AGENT holds `conversations:reply`/`conversations:resolve` but not
 * `conversations:assign` — see authorization.test.ts); these tests pin the two facts the
 * matrix alone cannot show: that no assignment route is reachable, and that the
 * `assignedAgentId` placeholder column is never written by the flows that do exist.
 */
describe('Checkpoint 7 — agent conversation foundation', () => {
  it('an AGENT cannot assign a conversation: no assignment route exists', async () => {
    membership(USER_B.id, 'AGENT');

    // Assignment would be a `PATCH /conversations/:id` — the verb this API already uses
    // for updates elsewhere (members, bots, knowledge). The conversation router mounts
    // only GET /:conversationId and POST /:conversationId/messages, so the request falls
    // through to the 404 handler and no write can occur.
    const res = await request(app)
      .patch(`/api/v1/conversations/${CONVERSATION_ID}`)
      .set('Authorization', authHeader(USER_B))
      .send({ assignedAgentId: USER_B.id });

    expect(res.status).toBe(404);
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
  });

  it('the reply flow never writes assignedAgentId — escalation sets status only', async () => {
    conversationBelongsToWorkspace();
    membership(USER_B.id, 'AGENT');
    prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID });
    botHasNoModel();
    prismaMock.knowledgeEntry.findMany.mockResolvedValue([]);
    prismaMock.message.create.mockResolvedValue({
      id: 'msg',
      conversationId: CONVERSATION_ID,
      role: 'USER',
      content: 'I need a human',
      createdAt: new Date(),
    });
    prismaMock.conversation.update.mockResolvedValue({
      id: CONVERSATION_ID,
      status: 'WAITING_FOR_HUMAN',
    });
    // The AI service asks for a human — the one branch of the reply flow that writes to
    // the conversation row.
    aiMock.chat.mockResolvedValue({
      status: 'fallback',
      response: 'Escalating to a human agent.',
      fallback_required: true,
    });

    const res = await request(app)
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', authHeader(USER_B))
      .send({ content: 'I need a human' });

    expect(res.status).toBe(201);
    // Strengthened in Checkpoint 6: there are now *two* routes to an escalation — Python
    // asking for a human, and Node short-circuiting on an unusable model. Without this the
    // test would pass on either, and would no longer be about the AI service's answer.
    expect(aiMock.chat).toHaveBeenCalledTimes(1);
    expect(prismaMock.conversation.update).toHaveBeenCalledTimes(1);
    const { data } = prismaMock.conversation.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // Exactly the status change — assignment stays for the future human-support workflow.
    expect(data).toEqual({ status: 'WAITING_FOR_HUMAN' });
    expect(data).not.toHaveProperty('assignedAgentId');
  });

  it('assignedAgentId is still declared on Conversation (present but untouched)', () => {
    // The column has no runtime behaviour yet, so there is nothing to exercise: the
    // durable guarantee is that it remains in the schema, ready for assignment to be
    // built on top of it. This fails loudly if a later migration drops it.
    const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const conversationModel = /model Conversation \{([\s\S]*?)\n\}/.exec(schema)?.[1];

    expect(conversationModel).toBeDefined();
    expect(conversationModel).toContain('assignedAgentId String?');
    // The status enum the escalation branch relies on.
    expect(conversationModel).toContain('status          ConversationStatus @default(ACTIVE)');
  });
});
