import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { LegacyBotRedirect } from '@/components/legacy-bot-redirect';

/**
 * Checkpoint 7 — the legacy bot URLs have no workspace id, so their redirect has to
 * resolve the bot first. These tests cover the two outcomes: a workspace-scoped
 * replacement and the failure path back to Home.
 */

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  push: vi.fn(),
}));

const getBot = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useParams: () => ({ botId: 'bot-1' }),
  useRouter: () => navigation,
}));

vi.mock('@/lib/api/bots', () => ({ getBot }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LegacyBotRedirect', () => {
  it('resolves the bot workspace and replaces the legacy URL', async () => {
    getBot.mockResolvedValue({
      id: 'bot-1',
      name: 'Billing Assistant',
      workspaceId: 'ws-123',
    });

    render(
      <ToastProvider>
        <LegacyBotRedirect suffix="/knowledge" label="Opening knowledge…" />
      </ToastProvider>,
    );

    expect(screen.getByText('Opening knowledge…')).toBeInTheDocument();

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith(
        '/w/ws-123/bots/bot-1/knowledge',
      );
    });
  });

  it('returns to Home when the bot cannot be resolved', async () => {
    getBot.mockRejectedValue(new Error('not found'));

    render(
      <ToastProvider>
        <LegacyBotRedirect suffix="/conversations" label="Opening conversations…" />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith('/home');
    });
    expect(await screen.findByText('Failed to load bot')).toBeInTheDocument();
  });
});
