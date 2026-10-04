import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { BOT_CONFIG_DEFAULTS } from '../src/constants/botDefaults.js';
import { decideEscalation } from '../src/services/escalationPolicy.js';
import type { ChatResponse } from '../src/services/aiServiceClient.js';
import type { ResolvedBotConfig } from '../src/types/botConfig.types.js';

/**
 * Checkpoint 5 — human-support escalation policy (§14, §23.1).
 *
 * Two layers, deliberately:
 *   - `decideEscalation` is a pure function, so the full matrix (fallback ON/OFF, human
 *     request × 3, off-hours × 3, copy ownership) is a table of exact assertions.
 *   - The route-level block proves the policy is *wired in*: the status transition and the
 *     stored message content are what the customer and the inbox actually see.
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

const primeConversation = (configOverrides: Record<string, unknown> = {}) => {
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

const send = (content = 'help') =>
  request(app)
    .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
    .set('Authorization', authHeader())
    .send({ content });

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------------------

const baseConfig = (): ResolvedBotConfig => ({
  general: { isActive: true, displayName: null, hasAvatar: false, avatarVersion: 0 },
  personality: {
    preset: 'PROFESSIONAL',
    tone: 'NEUTRAL',
    customPersonality: null,
    customInstructions: null,
    responseLanguage: 'AUTO',
    responseLength: 'BALANCED',
  },
  conversation: {
    welcomeMessage: null,
    conversationStarter: null,
    suggestedQuestions: [],
    inputPlaceholder: null,
    thinkingMessages: [],
    feedbackEnabled: false,
    feedbackCollectReason: true,
  },
  knowledge: { enabled: true, strictness: 'BALANCED', showSources: false, topK: 3 },
  generation: {
    temperature: 0,
    topP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    maxOutputTokens: null,
  },
  model: { aiModelId: null, fallbackAiModelId: null },
  humanSupport: {
    fallbackEnabled: true,
    fallbackMessage: null,
    humanRequestBehavior: 'TRANSFER_AUTOMATICALLY',
    handoffMessage: null,
    businessHours: null,
    contactCollection: null,
  },
});

const reply = (overrides: Partial<ChatResponse> = {}): ChatResponse => ({
  status: 'success',
  response: 'the answer',
  fallback_required: false,
  ...overrides,
});

const NOW = new Date('2026-07-06T12:00:00Z'); // Monday, midday UTC

const closedSundayHours = {
  timezone: 'UTC',
  windows: [{ day: 'MON' as const, start: '09:00', end: '17:00' }],
  afterHoursBehavior: 'MESSAGE_AND_ESCALATE' as const,
  afterHoursMessage: 'We are offline.',
};
const SUNDAY = new Date('2026-07-05T12:00:00Z');

describe('decideEscalation — fallback copy ownership', () => {
  it('escalates a conversational fallback and shows the platform copy when unset', () => {
    const config = baseConfig();
    const decision = decideEscalation(
      config,
      reply({ fallback_required: true, reason: 'NO_RELEVANT_KNOWLEDGE', response: 'platform copy' }),
      NOW
    );
    expect(decision.escalate).toBe(true);
    expect(decision.offHours).toBe(false);
    expect(decision.reason).toBe('NO_RELEVANT_KNOWLEDGE');
    expect(decision.response).toBe('platform copy');
  });

  it('replaces the conversational copy with the owner’s message', () => {
    const config = baseConfig();
    config.humanSupport.fallbackMessage = 'Owner copy';
    const decision = decideEscalation(
      config,
      reply({ fallback_required: true, reason: 'NO_RELEVANT_KNOWLEDGE', response: 'platform copy' }),
      NOW
    );
    expect(decision.response).toBe('Owner copy');
  });

  it('never rewords a platform fault, even when the owner set a message', () => {
    const config = baseConfig();
    config.humanSupport.fallbackMessage = 'Owner copy';
    const decision = decideEscalation(
      config,
      reply({ fallback_required: true, reason: 'MODEL_UNAVAILABLE', response: 'platform copy' }),
      NOW
    );
    expect(decision.response).toBe('platform copy');
    expect(decision.escalate).toBe(true);
  });
});

describe('decideEscalation — fallback ON/OFF', () => {
  it('escalates when fallback is enabled', () => {
    expect(decideEscalation(baseConfig(), reply({ fallback_required: true, reason: 'X' }), NOW).escalate).toBe(true);
  });

  it('never escalates when fallback is disabled', () => {
    const config = baseConfig();
    config.humanSupport.fallbackEnabled = false;
    const decision = decideEscalation(config, reply({ fallback_required: true, reason: 'X' }), NOW);
    expect(decision.escalate).toBe(false);
    expect(decision.offHours).toBe(false);
  });
});

describe('decideEscalation — human request behaviour', () => {
  it('TRANSFER_AUTOMATICALLY escalates and keeps the model’s answer', () => {
    const decision = decideEscalation(baseConfig(), reply({ human_requested: true, response: 'answer' }), NOW);
    expect(decision.escalate).toBe(true);
    expect(decision.response).toBe('answer');
    expect(decision.reason).toBe('HUMAN_REQUESTED');
  });

  it('TRANSFER_AUTOMATICALLY is inert when fallback is disabled', () => {
    const config = baseConfig();
    config.humanSupport.fallbackEnabled = false;
    const decision = decideEscalation(config, reply({ human_requested: true, response: 'answer' }), NOW);
    expect(decision.escalate).toBe(false);
    expect(decision.response).toBe('answer');
  });

  it('UNAVAILABLE_MESSAGE returns fixed copy and does not escalate', () => {
    const config = baseConfig();
    config.humanSupport.humanRequestBehavior = 'UNAVAILABLE_MESSAGE';
    const decision = decideEscalation(config, reply({ human_requested: true, response: 'answer' }), NOW);
    expect(decision.escalate).toBe(false);
    expect(decision.response).toContain("Human support isn't available");
  });

  it('CONTINUE_WITH_AI ignores the request and keeps the answer', () => {
    const config = baseConfig();
    config.humanSupport.humanRequestBehavior = 'CONTINUE_WITH_AI';
    const decision = decideEscalation(config, reply({ human_requested: true, response: 'answer' }), NOW);
    expect(decision.escalate).toBe(false);
    expect(decision.response).toBe('answer');
  });
});

describe('decideEscalation — business hours × afterHoursBehavior', () => {
  const offHours = (behavior: 'MESSAGE_ONLY' | 'MESSAGE_AND_ESCALATE' | 'ESCALATE') => {
    const config = baseConfig();
    config.humanSupport.businessHours = { ...closedSundayHours, afterHoursBehavior: behavior };
    return decideEscalation(config, reply({ fallback_required: true, reason: 'X', response: 'fallback' }), SUNDAY);
  };

  it('MESSAGE_ONLY does not escalate but shows the after-hours line', () => {
    const decision = offHours('MESSAGE_ONLY');
    expect(decision.escalate).toBe(false);
    expect(decision.offHours).toBe(false);
    expect(decision.acceptanceMessage).toBe('We are offline.');
  });

  it('MESSAGE_AND_ESCALATE escalates, marked off-hours', () => {
    const decision = offHours('MESSAGE_AND_ESCALATE');
    expect(decision.escalate).toBe(true);
    expect(decision.offHours).toBe(true);
    expect(decision.acceptanceMessage).toBe('We are offline.');
  });

  it('ESCALATE is treated as inside hours with no after-hours line', () => {
    const decision = offHours('ESCALATE');
    expect(decision.escalate).toBe(true);
    expect(decision.offHours).toBe(false);
    expect(decision.acceptanceMessage).toBeUndefined();
  });

  it('appends the handoff message when inside hours', () => {
    const config = baseConfig();
    config.humanSupport.handoffMessage = 'A teammate will pick this up.';
    const decision = decideEscalation(config, reply({ fallback_required: true, reason: 'X' }), NOW);
    expect(decision.escalate).toBe(true);
    expect(decision.acceptanceMessage).toBe('A teammate will pick this up.');
  });
});

// ---------------------------------------------------------------------------------------
// Route-level wiring
// ---------------------------------------------------------------------------------------

describe('POST messages — escalation is persisted exactly as the policy decides', () => {
  it('fallback ON writes WAITING_FOR_HUMAN with the escalation metadata', async () => {
    primeConversation();
    aiMock.chat.mockResolvedValue({
      status: 'fallback',
      response: 'platform copy',
      fallback_required: true,
      reason: 'NO_RELEVANT_KNOWLEDGE',
    });

    const res = await send();

    expect(res.status).toBe(201);
    expect(prismaMock.conversation.update).toHaveBeenCalledTimes(1);
    const { data } = prismaMock.conversation.update.mock.calls[0][0];
    expect(data).toMatchObject({
      status: 'WAITING_FOR_HUMAN',
      escalationReason: 'NO_RELEVANT_KNOWLEDGE',
      escalatedOffHours: false,
    });
    expect(res.body.data.assistantMessage.content).toBe('platform copy');
    expect(res.body.data.escalation).toMatchObject({ required: true, offHours: false });
  });

  it('fallback OFF never changes the status and shows the owner message', async () => {
    primeConversation({ humanFallbackEnabled: false, fallbackMessage: 'Owner copy' });
    aiMock.chat.mockResolvedValue({
      status: 'fallback',
      response: 'platform copy',
      fallback_required: true,
      reason: 'NO_RELEVANT_KNOWLEDGE',
    });

    const res = await send();

    expect(res.status).toBe(201);
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
    expect(res.body.data.assistantMessage.content).toBe('Owner copy');
    expect(res.body.data.escalation).toBeUndefined();
  });

  it('a human request escalates while keeping the model’s answer', async () => {
    primeConversation();
    aiMock.chat.mockResolvedValue({
      status: 'success',
      response: 'Here is the answer.',
      fallback_required: false,
      human_requested: true,
    });

    const res = await send('I want to talk to a human');

    expect(prismaMock.conversation.update).toHaveBeenCalledTimes(1);
    const { data } = prismaMock.conversation.update.mock.calls[0][0];
    expect(data.escalationReason).toBe('HUMAN_REQUESTED');
    expect(res.body.data.assistantMessage.content).toBe('Here is the answer.');
  });

  it('a paused bot answers without an AI call and without escalating', async () => {
    primeConversation();
    prismaMock.bot.findUnique.mockResolvedValue({
      isActive: false,
      aiModelId: null,
      fallbackAiModelId: null,
      aiModel: null,
      fallbackAiModel: null,
    });

    const res = await send();

    expect(res.status).toBe(201);
    expect(aiMock.chat).not.toHaveBeenCalled();
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();
    expect(res.body.data.assistantMessage.content).toContain('paused');
  });
});