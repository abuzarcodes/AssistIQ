import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), create: vi.fn() },
  workspace: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  bot: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  knowledgeEntry: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  conversation: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
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
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333';

const authHeader = (user: { id: string; email: string }): string =>
  `Bearer ${signToken({ sub: user.id, email: user.email })}`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/bots/:botId/conversations', () => {
  it('creates a conversation under a bot the caller owns (201)', async () => {
    prismaMock.bot.findFirst.mockResolvedValue({
      id: BOT_ID,
      name: 'Helper',
      description: null,
      workspaceId: '11111111-1111-1111-1111-111111111111',
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
    prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID });
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
      answer: 'Mock assistant reply',
      intent: 'faq_match',
      confidence: 0.9,
      fallback_required: false,
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
    expect(res.body.data.ai.answer).toBe('Mock assistant reply');

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

  it('cannot post to a conversation owned by another user (404) and never calls the AI service', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(null);

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
