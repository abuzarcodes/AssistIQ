import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { BOT_CONFIG_DEFAULTS } from '../src/constants/botDefaults.js';

/**
 * Checkpoint 9 — the cross-endpoint integration flows (§23.4).
 *
 * The per-checkpoint suites cover each policy in isolation. This one proves the wiring: a
 * stored configuration reaches the AI service on the message path, and the fallback toggle
 * changes the conversation's status exactly as the policy table says. It is the seam that
 * would break if a field were renamed on one side only.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspaceMember: { findUnique: vi.fn() },
  bot: { findUnique: vi.fn(), findFirst: vi.fn() },
  botConfiguration: { findUnique: vi.fn() },
  conversation: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  message: { create: vi.fn(), findFirst: vi.fn() },
  knowledgeSource: { findMany: vi.fn() },
  messageFeedback: { upsert: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
  conversationContact: { upsert: vi.fn() },
}));

const aiMock = vi.hoisted(() => ({ chat: vi.fn() }));

vi.mock('../src/config/database.js', () => ({ default: prismaMock, prisma: prismaMock }));
vi.mock('../src/services/aiServiceClient.js', () => ({ aiServiceClient: aiMock }));

const { default: app } = await import('../src/app.js');
const { signToken } = await import('../src/utils/jwt.js');

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const BOT_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = '33333333-3333-3333-3333-333333333333';

const authHeader = (): string =>
  `Bearer ${signToken({ sub: USER_ID, email: 'owner@example.com' })}`;

const configRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'cfg-1',
  botId: BOT_ID,
  version: 1,
  avatarVersion: 0,
  avatarData: null,
  avatarMimeType: null,
  avatarUpdatedAt: null,
  ...BOT_CONFIG_DEFAULTS,
  suggestedQuestions: [...BOT_CONFIG_DEFAULTS.suggestedQuestions],
  thinkingMessages: [...BOT_CONFIG_DEFAULTS.thinkingMessages],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const prime = (configOverrides: Record<string, unknown> = {}) => {
  prismaMock.conversation.findUnique.mockResolvedValue({ bot: { workspaceId: WORKSPACE_ID } });
  prismaMock.workspaceMember.findUnique.mockResolvedValue({
    id: 'm',
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    role: 'OWNER',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  prismaMock.conversation.findFirst.mockResolvedValue({ id: CONVERSATION_ID, botId: BOT_ID });
  prismaMock.bot.findUnique.mockResolvedValue({
    isActive: true,
    aiModelId: null,
    fallbackAiModelId: null,
    aiModel: null,
    fallbackAiModel: null,
  });
  prismaMock.botConfiguration.findUnique.mockResolvedValue(configRow(configOverrides));
  prismaMock.message.create.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: args.data.role === 'USER' ? 'msg-user' : 'msg-assistant',
      conversationId: CONVERSATION_ID,
      role: args.data.role,
      content: args.data.content,
      createdAt: new Date(),
    })
  );
  prismaMock.conversation.update.mockResolvedValue({ id: CONVERSATION_ID });
};

const send = () =>
  request(app)
    .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
    .set('Authorization', authHeader())
    .send({ content: 'What are your hours?' });

beforeEach(() => {
  vi.resetAllMocks();
  aiMock.chat.mockResolvedValue({ status: 'success', response: 'Nine to five.', fallback_required: false });
});

describe('configure → chat', () => {
  it('sends the stored configuration to the AI service', async () => {
    prime({
      personality: 'FRIENDLY',
      customInstructions: 'Always be brief.',
      responseLanguage: 'de',
    });

    await send();

    const payload = aiMock.chat.mock.calls[0][0];
    expect(payload.config.personality).toBe('FRIENDLY');
    expect(payload.config.custom_instructions).toBe('Always be brief.');
    expect(payload.config.response_language).toBe('de');
  });

  it('with fallback OFF, an unanswerable turn stays ACTIVE and shows the owner copy', async () => {
    prime({ humanFallbackEnabled: false, fallbackMessage: 'Sorry, I do not know that yet.' });
    aiMock.chat.mockResolvedValue({
      status: 'fallback',
      response: 'platform copy',
      fallback_required: true,
      reason: 'NO_RELEVANT_KNOWLEDGE',
    });

    const res = await send();

    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
    expect(res.body.data.assistantMessage.content).toBe('Sorry, I do not know that yet.');
  });

  it('with fallback ON, an unanswerable turn escalates with the escalation metadata', async () => {
    prime({ humanFallbackEnabled: true, handoffMessage: 'A teammate will pick this up.' });
    aiMock.chat.mockResolvedValue({
      status: 'fallback',
      response: 'platform copy',
      fallback_required: true,
      reason: 'LLM_INSUFFICIENT_INFORMATION',
    });

    const res = await send();

    expect(prismaMock.conversation.update).toHaveBeenCalledTimes(1);
    const { data } = prismaMock.conversation.update.mock.calls[0][0];
    expect(data).toMatchObject({
      status: 'WAITING_FOR_HUMAN',
      escalationReason: 'LLM_INSUFFICIENT_INFORMATION',
      escalatedOffHours: false,
    });
    expect(res.body.data.escalation.acceptanceMessage).toBe('A teammate will pick this up.');
  });

  it('persists sources only when the configuration shows them', async () => {
    prime({ showSources: true, knowledgeEnabled: true });
    aiMock.chat.mockResolvedValue({
      status: 'success',
      response: 'Here you go.',
      fallback_required: false,
      sources: [{ chunk_id: 'chunk-1', source_id: null, topic: null, page_number: null }],
    });

    const res = await send();

    expect(res.body.data.assistantMessage.content).toBe('Here you go.');
    expect(res.body.data.sources).toHaveLength(1);
    expect(res.body.data.sources[0].label).toBe('FAQ entry');
  });

  it('writes no sources when the configuration hides them', async () => {
    prime({ showSources: false });
    aiMock.chat.mockResolvedValue({
      status: 'success',
      response: 'Here you go.',
      fallback_required: false,
      sources: [{ chunk_id: 'chunk-1', source_id: null, topic: null, page_number: null }],
    });

    const res = await send();

    expect(res.body.data.sources).toBeUndefined();
    const { data } = prismaMock.message.create.mock.calls[1][0];
    expect(data).not.toHaveProperty('sources');
  });
});