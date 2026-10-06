import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import type { BotConfigResponse, ResolvedBotConfig } from '@/lib/api/botConfig';

/**
 * Checkpoint 6 — read-only mode without `bots:manage` (§16.3).
 *
 * A caller who may view but not manage sees the configuration, but every control is disabled
 * and the save bar is absent. The server would reject a write anyway; this is the honest
 * presentation.
 */

const getBotConfig = vi.fn();

vi.mock('@/lib/api/botConfig', () => ({
  getBotConfig: (...args: unknown[]) => getBotConfig(...args),
  updateBotConfig: vi.fn(),
  previewBotConfig: vi.fn(),
  getBotAvatarBlob: vi.fn().mockRejectedValue(new Error('none')),
  uploadBotAvatar: vi.fn(),
  deleteBotAvatar: vi.fn(),
  resetBotConfig: vi.fn(),
}));

vi.mock('@/lib/api/bots', () => ({ updateBot: vi.fn(), assignBotModel: vi.fn() }));

const { BotConfigTabs } = await import(
  '@/app/dashboard/bots/[botId]/_components/bot-config-tabs'
);

const config: ResolvedBotConfig = {
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
};

const response: BotConfigResponse = {
  config,
  effective: {
    appliedParams: {},
    ignoredParams: [],
    modelPromoted: false,
    modelUnavailable: false,
    knowledgeActive: false,
  },
  version: 1,
  updatedAt: null,
};

const bot = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Helper',
  description: null,
  workspaceId: '11111111-1111-1111-1111-111111111111',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  getBotConfig.mockResolvedValue(response);
});

describe('BotConfigTabs — read-only mode', () => {
  it('disables every input and hides the save bar', async () => {
    render(
      <ToastProvider>
        <BotConfigTabs
          bot={bot}
          models={[]}
          modelsLoading={false}
          modelsError={false}
          canManage={false}
          onBotChanged={() => {}}
        />
      </ToastProvider>,
    );

    const displayName = await screen.findByLabelText('Display name');
    expect(displayName).toBeDisabled();

    fireEvent.change(displayName, { target: { value: 'Ada' } });
    expect(screen.queryByText('You have unsaved changes.')).not.toBeInTheDocument();
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument();
  });
});