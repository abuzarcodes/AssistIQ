import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CustomerChatWidget } from '@/components/widget/CustomerChatWidget';
import HostedChatPage from '@/app/chat/[slug]/page';
import EmbedChatPage from '@/app/chat/embed/[deploymentId]/page';
import * as publicChatApi from '@/lib/api/publicChat';
import { PublicApiError } from '@/lib/api/publicChat';
import type { ExperienceConfigSnapshot } from '@/lib/api/experience';

/**
 * CP-11.1 – CP-11.10 — the production public chat.
 *
 * The widget renders the published snapshot's branding instead of the dashboard
 * defaults, the hosted page resolves slugs (falling back to deployment ids),
 * the embed page fills its frame or runs the loader protocol, and analytics
 * events fire without ever breaking the conversation.
 */

// Mock Next.js navigation with mutable holders.
const routeParams: { slug?: string; deploymentId?: string } = {};
const queryParams: { mode?: string | null } = {};
vi.mock('next/navigation', () => ({
  useParams: () => routeParams,
  useSearchParams: () => ({
    get: (key: string) => (key === 'mode' ? (queryParams.mode ?? null) : null),
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/chat/help',
}));

// Mock Socket.IO client.
const mockSocketInstance = {
  connected: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocketInstance),
}));

function config(
  overrides: Partial<ExperienceConfigSnapshot> = {},
): ExperienceConfigSnapshot {
  return {
    displayName: 'Acme Support',
    botAvatarUrl: null,
    businessLogoUrl: null,
    accentColor: '#123456',
    userBubbleColor: '#123456',
    botBubbleColor: '#abcdef',
    themeMode: 'light',
    themePreset: null,
    hostedPageTitle: 'Chat with Acme',
    hostedPageDescription: 'We answer in minutes.',
    widgetPosition: 'bottom-right',
    widgetLauncherLabel: null,
    widgetPanelWidth: 400,
    widgetPanelHeight: 600,
    widgetMobileBehavior: 'fullscreen',
    iframeWidth: '100%',
    iframeHeight: '600px',
    welcomeMessage: 'Welcome to Acme!',
    welcomeSubtitle: 'Ask us anything.',
    inputPlaceholder: 'Ask Acme…',
    suggestedQuestions: ['Where is my order?'],
    firstOpenBehavior: 'welcome',
    showTimestamps: true,
    autoOpen: false,
    privacyPolicyUrl: 'https://example.com/privacy',
    termsUrl: 'https://example.com/terms',
    showBranding: true,
    ...overrides,
  };
}

function payload(exp: ExperienceConfigSnapshot = config()) {
  return {
    deployment: {
      id: 'dep-1',
      botId: 'bot-1',
      workspaceId: 'ws-1',
      format: 'HOSTED_PAGE' as const,
      status: 'PUBLISHED' as const,
      slug: 'help',
      publishEpoch: 1,
      allowedDomains: [],
    },
    bot: { id: 'bot-1', name: 'Acme' },
    config: exp,
  };
}

function mockSession() {
  vi.spyOn(publicChatApi, 'startPublicConversation').mockResolvedValue({
    conversation: {
      id: 'conv-1',
      botId: 'bot-1',
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    },
    visitorToken: 'token-1',
    sessionSecret: 'secret-1',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  localStorage.clear();
  delete routeParams.slug;
  delete routeParams.deploymentId;
  queryParams.mode = null;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('Experience-aware CustomerChatWidget', () => {
  it('renders the published branding, welcome copy and footer', async () => {
    mockSession();
    render(
      <CustomerChatWidget
        botId="bot-1"
        botName="Acme"
        standalone
        experienceConfig={config()}
      />,
    );

    expect(await screen.findByText('Acme Support')).toBeInTheDocument();
    expect(screen.getByText('Welcome to Acme!')).toBeInTheDocument();
    expect(screen.getByText('Ask us anything.')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('Ask Acme…'),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Where is my order?' }),
    );
    expect(
      (screen.getByPlaceholderText('Ask Acme…') as HTMLInputElement).value,
    ).toBe('Where is my order?');

    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute(
      'href',
      'https://example.com/privacy',
    );
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute(
      'href',
      'https://example.com/terms',
    );
    expect(screen.getByText('Powered by AssistIQ')).toBeInTheDocument();
  });

  it('paints bubbles with the published colours and shows timestamps', async () => {
    mockSession();
    const sendSpy = vi
      .spyOn(publicChatApi, 'sendPublicMessage')
      .mockResolvedValue({
        userMessage: {
          id: 'm-1',
          role: 'USER',
          content: 'Hi',
          createdAt: new Date().toISOString(),
        },
        assistantMessage: {
          id: 'm-2',
          role: 'ASSISTANT',
          content: 'Hello!',
          createdAt: new Date().toISOString(),
        },
        suppressed: false,
      });

    render(
      <CustomerChatWidget
        botId="bot-1"
        botName="Acme"
        standalone
        experienceConfig={config()}
      />,
    );
    await screen.findByText('Acme Support');

    fireEvent.change(screen.getByPlaceholderText('Ask Acme…'), {
      target: { value: 'Hi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));
    const userBubble = (await screen.findByText('Hi')).closest('div[class*="rounded-2xl"]');
    expect(userBubble).toHaveStyle({ backgroundColor: '#123456' });
    const botBubble = await screen.findByText('Hello!');
    expect(
      botBubble.closest('div[class*="rounded-2xl"]'),
    ).toHaveStyle({ backgroundColor: '#abcdef' });
  });

  it('hides branding and the welcome screen when configured off', async () => {
    mockSession();
    render(
      <CustomerChatWidget
        botId="bot-1"
        botName="Acme"
        standalone
        experienceConfig={config({
          showBranding: false,
          privacyPolicyUrl: null,
          termsUrl: null,
          firstOpenBehavior: 'empty',
        })}
      />,
    );

    await screen.findByText('Acme Support');
    expect(screen.queryByText('Powered by AssistIQ')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Privacy' })).not.toBeInTheDocument();
    expect(screen.queryByText('Welcome to Acme!')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Send a message to start/),
    ).toBeInTheDocument();
  });

  it('renders the launcher label in the configured corner', async () => {
    mockSession();
    render(
      <CustomerChatWidget
        botId="bot-1"
        botName="Acme"
        defaultOpen={false}
        experienceConfig={config({
          widgetPosition: 'bottom-left',
          widgetLauncherLabel: 'Talk to us',
        })}
      />,
    );
    await waitFor(() =>
      expect(publicChatApi.startPublicConversation).toHaveBeenCalled(),
    );

    const launcher = screen.getByRole('button', { name: 'Open chat support' });
    expect(launcher).toHaveTextContent('Talk to us');
    expect(launcher).toHaveStyle({ backgroundColor: '#123456' });
    expect(launcher.parentElement).toHaveClass('bottom-5', 'left-5');
  });

  it('emits page_view and chat_start without breaking the chat', async () => {
    mockSession();
    const eventSpy = vi
      .spyOn(publicChatApi, 'recordDeploymentEvent')
      .mockResolvedValue({ recorded: true });
    vi.spyOn(publicChatApi, 'sendPublicMessage').mockResolvedValue({
      userMessage: {
        id: 'm-1',
        role: 'USER',
        content: 'Hi',
        createdAt: new Date().toISOString(),
      },
      assistantMessage: null,
      suppressed: true,
      suppressionReason: 'AI_BYPASSED',
    });

    render(
      <CustomerChatWidget
        botId="bot-1"
        botName="Acme"
        standalone
        experienceConfig={config()}
        deploymentId="dep-1"
      />,
    );
    await screen.findByText('Acme Support');

    await waitFor(() =>
      expect(eventSpy).toHaveBeenCalledWith('dep-1', {
        eventType: 'page_view',
      }),
    );

    fireEvent.change(screen.getByPlaceholderText('Ask Acme…'), {
      target: { value: 'Hi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(eventSpy).toHaveBeenCalledWith('dep-1', {
        eventType: 'chat_start',
        sessionId: 'conv-1',
      }),
    );
  });
});

describe('Hosted chat page', () => {
  it('renders the title, description and branded chat from a slug', async () => {
    routeParams.slug = 'help';
    const slugSpy = vi
      .spyOn(publicChatApi, 'getPublishedConfigBySlug')
      .mockResolvedValue(payload());
    mockSession();

    render(<HostedChatPage />);

    await waitFor(() => expect(slugSpy).toHaveBeenCalledWith('help'));
    expect(await screen.findByText('Chat with Acme')).toBeInTheDocument();
    expect(screen.getByText('We answer in minutes.')).toBeInTheDocument();
    expect(await screen.findByText('Acme Support')).toBeInTheDocument();
    expect(document.title).toContain('Chat with Acme');
  });

  it('falls back to the deployment id before giving up', async () => {
    routeParams.slug = 'dep-1';
    vi.spyOn(publicChatApi, 'getPublishedConfigBySlug').mockRejectedValue(
      new PublicApiError('Not found', 404),
    );
    const idSpy = vi
      .spyOn(publicChatApi, 'getPublishedConfigByDeploymentId')
      .mockResolvedValue(payload());

    render(<HostedChatPage />);

    await waitFor(() => expect(idSpy).toHaveBeenCalledWith('dep-1'));
    expect(await screen.findByText('Chat with Acme')).toBeInTheDocument();
  });

  it('shows an unavailable state when nothing is published', async () => {
    routeParams.slug = 'gone';
    vi.spyOn(publicChatApi, 'getPublishedConfigBySlug').mockRejectedValue(
      new PublicApiError('Not found', 404),
    );
    vi.spyOn(publicChatApi, 'getPublishedConfigByDeploymentId').mockRejectedValue(
      new PublicApiError('Not found', 404),
    );

    render(<HostedChatPage />);

    expect(
      await screen.findByText('This chat is unavailable'),
    ).toBeInTheDocument();
  });
});

describe('Embed chat page', () => {
  it('fills the frame with the full chat by default', async () => {
    routeParams.deploymentId = 'dep-1';
    mockSession();
    const idSpy = vi
      .spyOn(publicChatApi, 'getPublishedConfigByDeploymentId')
      .mockResolvedValue(payload());

    render(<EmbedChatPage />);

    await waitFor(() => expect(idSpy).toHaveBeenCalledWith('dep-1'));
    expect(await screen.findByText('Welcome to Acme!')).toBeInTheDocument();
  });

  it('runs the loader protocol in widget mode', async () => {
    routeParams.deploymentId = 'dep-1';
    queryParams.mode = 'widget';
    mockSession();
    vi.spyOn(publicChatApi, 'getPublishedConfigByDeploymentId').mockResolvedValue(
      payload(),
    );
    const postSpy = vi.spyOn(window, 'postMessage');

    render(<EmbedChatPage />);
    const launcher = await screen.findByRole('button', {
      name: 'Open chat support',
    });

    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'assistiq-widget',
          deploymentId: 'dep-1',
          type: 'position',
          position: 'bottom-right',
        }),
        '*',
      ),
    );

    fireEvent.click(launcher);
    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'state', open: true }),
        '*',
      ),
    );
    expect(
      await screen.findByRole('button', { name: 'Close chat' }),
    ).toBeInTheDocument();
  });
});

describe('Widget loader script', () => {
  it('implements the loader contract in a tiny static file', () => {
    const source = readFileSync(
      join(process.cwd(), 'public', 'widget', 'loader.js'),
      'utf8',
    );

    expect(source.length).toBeLessThan(4096);
    for (const token of [
      'data-deployment-id',
      'assistiq-widget',
      'chat/embed/',
      '?mode=widget',
      "'position'",
      "'resize'",
      'clipboard-write',
      'destroy',
    ]) {
      expect(source).toContain(token);
    }
  });
});
