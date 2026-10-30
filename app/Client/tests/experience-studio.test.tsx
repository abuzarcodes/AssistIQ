import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import type { ExperienceResponse } from '@/lib/api/experience';
import type { ResolvedBotConfig } from '@/lib/api/botConfig';

/**
 * CP-8.5 – CP-8.9 — the Studio draft lifecycle.
 *
 * The risky client logic: the page loads the draft, only changed fields are sent,
 * a failed save keeps every edit, and a 409 opens the conflict dialog instead of
 * overwriting another user's work.
 */

const updateExperience = vi.fn();

vi.mock('@/lib/api/experience', () => ({
  updateExperience: (...args: unknown[]) => updateExperience(...args),
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

const renderStudio = (canManage = true, initial = experience()) =>
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
          welcomeMessage: 'Hello there',
          inputPlaceholder: null,
          suggestedQuestions: [],
        }}
        aiDraft={aiDraft}
      />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ExperienceStudio', () => {
  it('renders the loaded draft in the Design tab', () => {
    renderStudio();

    expect(screen.getByLabelText('Display name')).toHaveValue('Helper');
    expect(screen.getByLabelText('Accent colour')).toHaveValue('#ff6b35');
    expect(screen.getByLabelText('Welcome message')).toHaveValue('Hello there');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Design',
      'Preview',
      'Publish',
      'Deploy',
      'Analytics',
    ]);
  });

  it('gives a read-only user disabled controls and no save bar', () => {
    renderStudio(false);

    expect(screen.getByLabelText('Display name')).toBeDisabled();
    expect(
      screen.getByText(/read-only access to this bot’s experience/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save changes' }),
    ).not.toBeInTheDocument();
  });

  it('tracks an edit and saves only the changed field with the version token', async () => {
    updateExperience.mockResolvedValueOnce(
      experience({ displayName: 'Support', version: 4 }),
    );

    renderStudio();

    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'Support' },
    });

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(updateExperience).toHaveBeenCalledWith(BOT, {
        displayName: 'Support',
        expectedVersion: 3,
      }),
    );
    await waitFor(() => expect(screen.getByText('Experience saved')).toBeInTheDocument());
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('opens the conflict dialog on 409 instead of overwriting', async () => {
    updateExperience.mockRejectedValueOnce(
      new ApiError('Conflict', 409, {
        data: experience({ displayName: 'Someone else', version: 4 }),
      }),
    );

    renderStudio();

    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'Mine' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(
        screen.getByText('This experience was changed elsewhere'),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Display name')).toHaveValue(
        'Someone else',
      ),
    );
  });

  it('keeps the draft when a save fails for another reason', async () => {
    updateExperience.mockRejectedValueOnce(new ApiError('Server exploded', 500));

    renderStudio();

    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'Mine' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getAllByText('Server exploded').length).toBeGreaterThan(0),
    );
    expect(screen.getByLabelText('Display name')).toHaveValue('Mine');
  });
});
