import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ResolvedBotConfig } from '@/lib/api/botConfig';

/**
 * Checkpoint 7 — the preview panel (§17, §23.3).
 *
 * The properties: it uses the draft, makes no network call on render, shows the Draft badge,
 * and renders an error inline without touching the draft.
 */

const previewBotConfig = vi.fn();

vi.mock('@/lib/api/botConfig', () => ({
  previewBotConfig: (...args: unknown[]) => previewBotConfig(...args),
  getBotAvatarBlob: vi.fn().mockRejectedValue(new Error('none')),
}));

const { PreviewPanel } = await import(
  '@/app/dashboard/bots/[botId]/_components/preview-panel'
);

const draft: ResolvedBotConfig = {
  general: { isActive: true, displayName: 'Ada', hasAvatar: false, avatarVersion: 0 },
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
    suggestedQuestions: ['How do refunds work?'],
    inputPlaceholder: 'Ask us anything…',
    thinkingMessages: ['Checking…'],
    feedbackEnabled: false,
    feedbackCollectReason: true,
  },
  knowledge: { enabled: true, strictness: 'BALANCED', showSources: true, topK: 3 },
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PreviewPanel', () => {
  it('shows the Draft badge and the welcome copy without a network call', () => {
    render(<PreviewPanel botId="bot-1" botName="Helper" draft={draft} />);

    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Hello there!')).toBeInTheDocument();
    expect(previewBotConfig).not.toHaveBeenCalled();
  });

  it('sends the draft and renders the answer', async () => {
    previewBotConfig.mockResolvedValue({
      response: 'Refunds take five days.',
      fallback_required: false,
      appliedParams: {},
      ignoredParams: [],
    });
    render(<PreviewPanel botId="bot-1" botName="Helper" draft={draft} />);

    fireEvent.change(screen.getByLabelText('Preview message'), {
      target: { value: 'How do refunds work?' },
    });
    fireEvent.submit(screen.getByLabelText('Preview message').closest('form')!);

    await waitFor(() => expect(previewBotConfig).toHaveBeenCalledTimes(1));
    expect(previewBotConfig).toHaveBeenCalledWith('bot-1', 'How do refunds work?', draft);
    expect(await screen.findByText('Refunds take five days.')).toBeInTheDocument();
  });

  it('surfaces an error inline', async () => {
    previewBotConfig.mockRejectedValue(new Error('network down'));
    render(<PreviewPanel botId="bot-1" botName="Helper" draft={draft} />);

    fireEvent.change(screen.getByLabelText('Preview message'), {
      target: { value: 'hi' },
    });
    fireEvent.submit(screen.getByLabelText('Preview message').closest('form')!);

    expect(
      await screen.findByText(/could not reach the assistant/i),
    ).toBeInTheDocument();
  });

  it('fills the input from a suggested-question chip', () => {
    render(<PreviewPanel botId="bot-1" botName="Helper" draft={draft} />);

    fireEvent.click(screen.getByRole('button', { name: 'How do refunds work?' }));

    expect((screen.getByLabelText('Preview message') as HTMLInputElement).value).toBe(
      'How do refunds work?',
    );
  });
});