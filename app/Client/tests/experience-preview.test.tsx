import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import type { ExperienceResponse } from '@/lib/api/experience';
import type { ResolvedBotConfig } from '@/lib/api/botConfig';

/**
 * CP-10.1 – CP-10.11 — the live preview.
 *
 * The preview reads the same draft object as the Design tab, renders each format
 * in a device frame, and sends test messages through the bot's existing preview
 * endpoint. Previewing never saves: no update call, no conversation row, nothing
 * counted in analytics — the test only asserts the client half (the preview
 * endpoint, verified server-side, performs no writes) and that the UI labels the
 * activity as a test.
 */

const previewBotConfig = vi.fn();

vi.mock('@/lib/api/botConfig', () => ({
  previewBotConfig: (...args: unknown[]) => previewBotConfig(...args),
  getBotAvatarBlob: vi.fn().mockRejectedValue(new Error('none')),
}));

const { ExperienceStudio } = await import(
  '@/app/w/[workspaceId]/bots/[botId]/experience/_components/experience-studio'
);

const BOT = '11111111-1111-1111-1111-111111111111';

function experience(
  overrides: Partial<ExperienceResponse> = {},
): ExperienceResponse {
  return {
    id: 'exp-1',
    botId: BOT,
    displayName: 'Helper',
    botAvatarUrl: null,
    businessLogoUrl: null,
    accentColor: '#ff6b35',
    userBubbleColor: null,
    botBubbleColor: null,
    themeMode: 'system',
    themePreset: null,
    hostedPageTitle: null,
    hostedPageDescription: null,
    widgetPosition: 'bottom-right',
    widgetLauncherLabel: null,
    widgetPanelWidth: 400,
    widgetPanelHeight: 600,
    widgetMobileBehavior: 'fullscreen',
    iframeWidth: '100%',
    iframeHeight: '600px',
    welcomeMessage: 'Hello there',
    welcomeSubtitle: null,
    inputPlaceholder: null,
    suggestedQuestions: [],
    firstOpenBehavior: 'welcome',
    showTimestamps: true,
    autoOpen: false,
    privacyPolicyUrl: null,
    termsUrl: null,
    showBranding: true,
    version: 3,
    publishedVersionId: null,
    publishedVersion: null,
    deployments: [],
    effective: {
      displayName: 'Helper',
      welcomeMessage: 'Hello there',
      suggestedQuestions: [],
      isDisplayNameOverridden: true,
      isWelcomeMessageOverridden: true,
      isSuggestedQuestionsOverridden: false,
    },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const aiDraft: ResolvedBotConfig = {
  general: { isActive: true, displayName: 'Helper', hasAvatar: false, avatarVersion: 0 },
  personality: {
    preset: 'FRIENDLY',
    tone: 'NEUTRAL',
    customPersonality: null,
    customInstructions: null,
    responseLanguage: 'AUTO',
    responseLength: 'BALANCED',
  },
  conversation: {
    welcomeMessage: 'Hello there!',
    conversationStarter: null,
    suggestedQuestions: [],
    inputPlaceholder: null,
    thinkingMessages: [],
    feedbackEnabled: false,
    feedbackCollectReason: false,
  },
  knowledge: { enabled: false, strictness: 'BALANCED', showSources: false, topK: 3 },
  generation: {
    temperature: 0,
    topP: null,
    frequencyPenalty: null,
    presencePenalty: null,
    maxOutputTokens: null,
  },
  model: { aiModelId: null, fallbackAiModelId: null },
  humanSupport: {
    fallbackEnabled: false,
    fallbackMessage: null,
    humanRequestBehavior: 'TRANSFER_AUTOMATICALLY',
    handoffMessage: null,
    businessHours: null,
    contactCollection: null,
  },
};

const renderStudio = (initial = experience(), canManage = true) =>
  render(
    <ToastProvider>
      <ExperienceStudio
        initialExperience={initial}
        canManage={canManage}
        botId={BOT}
        botName="Helper"
        avatar={{ hasAvatar: false, avatarVersion: 0 }}
        fallbacks={{
          displayName: 'Helper',
          welcomeMessage: 'Bot greeting',
          inputPlaceholder: 'Ask us anything',
          suggestedQuestions: ['Where is my order?', 'Returns'],
        }}
        aiDraft={aiDraft}
      />
    </ToastProvider>,
  );

function openPreview() {
  fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Experience Preview tab', () => {
  it('renders the draft chat with no network call', () => {
    renderStudio();
    openPreview();

    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(screen.getByText(/Desktop · 400 by 600/)).toBeInTheDocument();
    expect(screen.getByText('Test activity')).toBeInTheDocument();
    expect(previewBotConfig).not.toHaveBeenCalled();
  });

  it('toggles the device frame and each format shell', () => {
    renderStudio(
      experience({ widgetLauncherLabel: 'Talk to us', autoOpen: false }),
    );
    openPreview();

    fireEvent.click(screen.getByRole('radio', { name: 'Mobile' }));
    expect(screen.getByText(/Mobile · 375 by 667/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /mobile/i })).toHaveStyle({
      maxWidth: '375px',
    });

    fireEvent.click(screen.getByRole('radio', { name: 'Widget' }));
    const launcher = screen.getByRole('button', { name: 'Open chat preview' });
    expect(launcher).toHaveTextContent('Talk to us');

    fireEvent.click(launcher);
    expect(
      screen.getByRole('button', { name: 'Close chat preview' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Test message')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Iframe' }));
    expect(screen.getByText(/Embed · 100% by 600px/)).toBeInTheDocument();
  });

  it('opens the widget panel immediately when auto-open is on', () => {
    renderStudio(experience({ autoOpen: true }));
    openPreview();

    fireEvent.click(screen.getByRole('radio', { name: 'Widget' }));

    expect(
      screen.queryByRole('button', { name: 'Open chat preview' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Close chat preview' }),
    ).toBeInTheDocument();
  });

  it('shows an empty state when first-open is empty', () => {
    renderStudio(experience({ firstOpenBehavior: 'empty' }));
    openPreview();

    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
    expect(screen.queryByText('Hello there')).not.toBeInTheDocument();
  });

  it('reflects a Design tab colour change without saving', () => {
    renderStudio();

    fireEvent.change(screen.getByLabelText('Accent colour'), {
      target: { value: '#123456' },
    });
    openPreview();
    fireEvent.click(screen.getByRole('radio', { name: 'Widget' }));

    expect(
      screen.getByRole('button', { name: 'Open chat preview' }),
    ).toHaveStyle({ backgroundColor: '#123456' });
    expect(previewBotConfig).not.toHaveBeenCalled();
  });

  it('sends a test message through the preview endpoint and renders the answer', async () => {
    previewBotConfig.mockResolvedValueOnce({ response: 'Refunds take five days.' });
    renderStudio();
    openPreview();

    fireEvent.change(screen.getByLabelText('Test message'), {
      target: { value: 'How do refunds work?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }));

    await waitFor(() => expect(previewBotConfig).toHaveBeenCalledTimes(1));
    expect(previewBotConfig).toHaveBeenCalledWith(
      BOT,
      'How do refunds work?',
      aiDraft,
    );
    expect(
      await screen.findByText('Refunds take five days.'),
    ).toBeInTheDocument();
    expect(screen.getByText('How do refunds work?')).toBeInTheDocument();
  });

  it('surfaces a failed test message inline and keeps the draft', async () => {
    previewBotConfig.mockRejectedValueOnce(new ApiError('boom', 500));
    renderStudio();
    openPreview();

    fireEvent.change(screen.getByLabelText('Test message'), {
      target: { value: 'hi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }));

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'Design' }),
    ).toBeInTheDocument();
  });

  it('resets the test conversation without touching the draft', async () => {
    previewBotConfig.mockResolvedValueOnce({ response: 'Hello back.' });
    renderStudio();
    openPreview();

    fireEvent.change(screen.getByLabelText('Test message'), {
      target: { value: 'hi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send test message' }));
    expect(await screen.findByText('Hello back.')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Reset conversation' }),
    );
    expect(screen.queryByText('Hello back.')).not.toBeInTheDocument();
    expect(screen.getByText('Hello there')).toBeInTheDocument();
  });

  it('disables sending for read-only users while still showing the draft', () => {
    renderStudio(experience(), false);
    openPreview();

    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(
      screen.getByText(/needs bot management access/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Test message')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Send test message' }),
    ).toBeDisabled();
  });
});
