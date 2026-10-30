import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import type { ExperienceResponse } from '@/lib/api/experience';
import type { ResolvedBotConfig } from '@/lib/api/botConfig';

/**
 * CP-9.1 – CP-9.13 — the customization surface.
 *
 * These cover the behaviour an owner would notice if it broke: sections are present,
 * a preset writes its four fields, an invalid colour blocks the request, reset clears
 * the draft, inherited values are named, and the toggles edit the draft.
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Experience Design tab', () => {
  it('renders every customization section', () => {
    renderStudio();

    for (const heading of [
      'Branding',
      'Theme',
      'Layout',
      'Welcome',
      'Chat behavior',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }

    expect(screen.getByText('Live summary')).toBeInTheDocument();
  });

  it('applies a preset to the accent, both bubbles and the mode', () => {
    renderStudio();

    fireEvent.click(screen.getByRole('radio', { name: /^Professional/ }));

    expect(screen.getByLabelText('Accent colour')).toHaveValue('#1d4ed8');
    expect(screen.getByLabelText('Customer bubble')).toHaveValue('#1d4ed8');
    expect(screen.getByLabelText('Bot bubble')).toHaveValue('#eff6ff');
    expect(
      screen.getByRole('radio', { name: /^Light/ }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('keeps a customised colour after the preset is no longer matched', () => {
    renderStudio();

    fireEvent.click(screen.getByRole('radio', { name: /^Professional/ }));
    fireEvent.change(screen.getByLabelText('Accent colour'), {
      target: { value: '#123456' },
    });

    expect(screen.getByText('Custom colours in use')).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /^Professional/ }),
    ).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Accent colour')).toHaveValue('#123456');
  });

  it('blocks the save and names the field when a colour is invalid', () => {
    renderStudio();

    fireEvent.change(screen.getByLabelText('Accent colour'), {
      target: { value: 'not-a-colour' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(updateExperience).not.toHaveBeenCalled();
    expect(
      screen.getAllByText(/accent colour must be a hex value/i).length,
    ).toBeGreaterThan(0);
  });

  it('returns every field to the platform defaults after confirmation', () => {
    renderStudio();

    fireEvent.change(screen.getByLabelText('Display name'), {
      target: { value: 'Support' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(/live experience does not change/i),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset fields' }));

    expect(screen.getByLabelText('Display name')).toHaveValue('');
    expect(screen.getByLabelText('Welcome message')).toHaveValue('');
    expect(screen.getByLabelText('Accent colour')).toHaveValue('#ff6b35');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('names the inherited values when a field is empty', () => {
    renderStudio(experience({ welcomeMessage: null, inputPlaceholder: null }));

    expect(screen.getByLabelText('Welcome message')).toHaveValue('');
    expect(screen.getAllByText(/Bot greeting/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Ask us anything/).length).toBeGreaterThan(0);
  });

  it('adds a suggested question and refuses a duplicate', () => {
    renderStudio(experience({ suggestedQuestions: [] }));

    const field = screen.getByLabelText('New suggested question');

    fireEvent.change(field, { target: { value: 'Do you ship abroad?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getAllByText('Do you ship abroad?').length).toBeGreaterThan(0);

    fireEvent.change(field, { target: { value: 'do you ship abroad?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(
      screen.getByText('That question is already in the list'),
    ).toBeInTheDocument();
  });

  it('warns when the widget would open itself', () => {
    renderStudio();

    fireEvent.click(screen.getByRole('switch', { name: 'Open automatically' }));

    expect(
      screen.getByText(/interrupts whatever the visitor was doing/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('edits timestamps and first-open behavior through the draft', () => {
    renderStudio();

    fireEvent.click(screen.getByRole('switch', { name: 'Show timestamps' }));
    fireEvent.click(screen.getByRole('radio', { name: /^Empty conversation/ }));

    expect(
      screen.getByRole('switch', { name: 'Show timestamps' }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('radio', { name: /^Empty conversation/ }),
    ).toHaveAttribute('aria-checked', 'true');
  });
});
