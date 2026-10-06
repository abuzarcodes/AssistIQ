import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * Checkpoint 6 — the avatar component (§9.5, §23.3).
 *
 * An `<img src>` cannot carry the bearer token, so the bytes are fetched as a blob and
 * rendered from an object URL, which must be revoked on unmount — an object URL is a leak
 * otherwise.
 */

const getBotAvatarBlob = vi.fn();

vi.mock('@/lib/api/botConfig', () => ({
  getBotAvatarBlob: (...args: unknown[]) => getBotAvatarBlob(...args),
}));

const { BotAvatar } = await import(
  '@/app/dashboard/bots/[botId]/_components/bot-avatar'
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:avatar'),
    revokeObjectURL: vi.fn(),
  });
});

describe('BotAvatar', () => {
  it('renders the initial when there is no avatar', () => {
    render(<BotAvatar botId="bot-1" hasAvatar={false} avatarVersion={0} name="Helper" />);

    expect(screen.getByText('H')).toBeInTheDocument();
    expect(getBotAvatarBlob).not.toHaveBeenCalled();
  });

  it('fetches the blob and renders an object URL when an avatar exists', async () => {
    getBotAvatarBlob.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    render(<BotAvatar botId="bot-1" hasAvatar avatarVersion={2} name="Helper" />);

    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', 'blob:avatar');
    expect(getBotAvatarBlob).toHaveBeenCalledWith('bot-1');
  });

  it('revokes the object URL on unmount', async () => {
    getBotAvatarBlob.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    const { unmount } = render(
      <BotAvatar botId="bot-1" hasAvatar avatarVersion={2} name="Helper" />,
    );

    await screen.findByRole('img');
    unmount();

    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:avatar'));
  });
});