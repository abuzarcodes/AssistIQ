import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import type { BotConfigResponse, ResolvedBotConfig } from '@/lib/api/botConfig';

/**
 * Checkpoint 6 — the configuration center's draft lifecycle (§16.2, §23.3).
 *
 * The high-risk logic: dirty detection drives the save bar, save sends only the changed
 * fields plus the concurrency token, a failed save preserves the draft, and a 409 opens the
 * conflict dialog rather than overwriting.
 */

const getBotConfig = vi.fn();
const updateBotConfig = vi.fn();
const previewBotConfig = vi.fn();
const getBotAvatarBlob = vi.fn();

vi.mock('@/lib/api/botConfig', () => ({
  getBotConfig: (...args: unknown[]) => getBotConfig(...args),
  updateBotConfig: (...args: unknown[]) => updateBotConfig(...args),
  previewBotConfig: (...args: unknown[]) => previewBotConfig(...args),
  getBotAvatarBlob: (...args: unknown[]) => getBotAvatarBlob(...args),
  uploadBotAvatar: vi.fn(),
  deleteBotAvatar: vi.fn(),
  resetBotConfig: vi.fn(),
}));

vi.mock('@/lib/api/bots', () => ({
  updateBot: vi.fn(),
  assignBotModel: vi.fn(),
}));

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

const response = (overrides: Partial<BotConfigResponse> = {}): BotConfigResponse => ({
  config,
  effective: {
    appliedParams: { temperature: 0 },
    ignoredParams: [],
    modelPromoted: false,
    modelUnavailable: false,
    knowledgeActive: false,
  },
  version: 4,
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const bot = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Helper',
  description: null,
  workspaceId: '11111111-1111-1111-1111-111111111111',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  aiModelId: null,
  aiModel: null,
  isActive: true,
};

const renderTabs = (canManage = true) =>
  render(
    <ToastProvider>
      <BotConfigTabs
        bot={bot}
        models={[]}
        modelsLoading={false}
        modelsError={false}
        canManage={canManage}
        onBotChanged={() => {}}
      />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  getBotConfig.mockResolvedValue(response());
  getBotAvatarBlob.mockRejectedValue(new Error('no avatar'));
});

describe('BotConfigTabs — draft lifecycle', () => {
  it('loads the configuration and shows no save bar initially', async () => {
    renderTabs();

    expect(await screen.findByLabelText('Display name')).toBeInTheDocument();
    expect(screen.queryByText('You have unsaved changes.')).not.toBeInTheDocument();
  });

  it('shows the save bar when a field changes', async () => {
    renderTabs();
    const displayName = await screen.findByLabelText('Display name');

    fireEvent.change(displayName, { target: { value: 'Ada' } });

    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument();
  });

  it('sends only the changed field plus expectedVersion', async () => {
    updateBotConfig.mockResolvedValue(response());
    renderTabs();
    const displayName = await screen.findByLabelText('Display name');
    fireEvent.change(displayName, { target: { value: 'Ada' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(updateBotConfig).toHaveBeenCalledTimes(1));
    expect(updateBotConfig).toHaveBeenCalledWith(bot.id, {
      expectedVersion: 4,
      displayName: 'Ada',
    });
  });

  it('discard restores the saved value', async () => {
    renderTabs();
    const displayName = await screen.findByLabelText('Display name');
    fireEvent.change(displayName, { target: { value: 'Ada' } });

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.queryByText('You have unsaved changes.')).not.toBeInTheDocument();
    expect((displayName as HTMLInputElement).value).toBe('');
  });

  it('preserves the draft when a save fails', async () => {
    updateBotConfig.mockRejectedValue(new ApiError('Server exploded', 500));
    renderTabs();
    const displayName = await screen.findByLabelText('Display name');
    fireEvent.change(displayName, { target: { value: 'Ada' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    // The message appears twice: once in the save bar and once as a toast.
    expect((await screen.findAllByText('Server exploded')).length).toBeGreaterThan(0);
    // The typed value survives the failure.
    expect((displayName as HTMLInputElement).value).toBe('Ada');
    // The save bar is still showing (with the error in place of the "unsaved" line).
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('opens the conflict dialog on 409', async () => {
    const current = response({ version: 5 });
    updateBotConfig.mockRejectedValue(new ApiError('conflict', 409, { data: current }));
    renderTabs();
    const displayName = await screen.findByLabelText('Display name');
    fireEvent.change(displayName, { target: { value: 'Ada' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('This bot was changed elsewhere')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument();
  });
});