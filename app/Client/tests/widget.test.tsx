import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { CustomerChatWidget } from '@/components/widget/CustomerChatWidget';
import StandaloneWidgetPage from '@/app/widget/[botId]/page';
import * as publicChatApi from '@/lib/api/publicChat';

// Mock Next.js navigation
const mockParams = { botId: 'bot-1' };
vi.mock('next/navigation', () => ({
  useParams: () => mockParams,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/widget/bot-1',
}));

// Mock Socket.IO client
type EventHandler = (...args: unknown[]) => void;
const socketListeners: Record<string, EventHandler[]> = {};

const mockSocketInstance = {
  connected: false,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn((event: string, handler: EventHandler) => {
    if (!socketListeners[event]) socketListeners[event] = [];
    socketListeners[event].push(handler);
  }),
  off: vi.fn((event: string, handler: EventHandler) => {
    if (socketListeners[event]) {
      socketListeners[event] = socketListeners[event].filter((h) => h !== handler);
    }
  }),
  emit: vi.fn((event: string, data: unknown, cb?: () => void) => {
    if (typeof cb === 'function') cb();
  }),
};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    mockSocketInstance.connected = true;
    return mockSocketInstance;
  }),
}));

describe('CustomerChatWidget Component (CP6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.keys(socketListeners).forEach((k) => delete socketListeners[k]);

    // Polyfill scrollIntoView if missing
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('initializes conversation and stores visitor session in localStorage', async () => {
    const startSpy = vi.spyOn(publicChatApi, 'startPublicConversation').mockResolvedValueOnce({
      conversation: {
        id: 'conv-101',
        botId: 'bot-1',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
      },
      visitorToken: 'mock-visitor-token-101',
      sessionSecret: 'mock-session-secret-101',
    });

    render(<CustomerChatWidget botId="bot-1" defaultOpen={true} />);

    // Should call startPublicConversation
    await waitFor(() => {
      expect(startSpy).toHaveBeenCalledWith('bot-1');
    });

    // Should store sessionSecret and conversation in localStorage
    await waitFor(() => {
      const stored = localStorage.getItem('assistiq_session_bot-1');
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed.conversationId).toBe('conv-101');
      expect(parsed.sessionSecret).toBe('mock-session-secret-101');
      expect(parsed.visitorToken).toBe('mock-visitor-token-101');
    });

    // Should connect to Socket.IO and join room
    expect(mockSocketInstance.on).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(mockSocketInstance.on).toHaveBeenCalledWith('message:new', expect.any(Function));

    // Simulate socket connect event
    act(() => {
      socketListeners['connect']?.forEach((fn) => fn());
    });

    expect(mockSocketInstance.emit).toHaveBeenCalledWith(
      'room:join',
      { room: 'conversation:conv-101' },
      expect.any(Function),
    );
  });

  it('resumes existing session from localStorage and fetches transcript', async () => {
    localStorage.setItem(
      'assistiq_session_bot-1',
      JSON.stringify({
        conversationId: 'conv-resumed-202',
        sessionSecret: 'secret-202',
        visitorToken: 'token-202',
        botId: 'bot-1',
        createdAt: new Date().toISOString(),
      }),
    );

    const getTranscriptSpy = vi.spyOn(publicChatApi, 'getPublicTranscript').mockResolvedValueOnce({
      conversation: {
        id: 'conv-resumed-202',
        botId: 'bot-1',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
      },
      items: [
        {
          id: 'msg-prev-1',
          role: 'USER',
          content: 'Hello previously',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'msg-prev-2',
          role: 'ASSISTANT',
          content: 'Welcome back! How may I assist you?',
          createdAt: new Date().toISOString(),
        },
      ],
    });

    render(<CustomerChatWidget botId="bot-1" defaultOpen={true} />);

    await waitFor(() => {
      expect(getTranscriptSpy).toHaveBeenCalledWith('conv-resumed-202', 'token-202');
    });

    expect(await screen.findByText('Hello previously')).toBeDefined();
    expect(await screen.findByText('Welcome back! How may I assist you?')).toBeDefined();
  });

  it('displays waiting banner when status transitions to WAITING_FOR_HUMAN', async () => {
    vi.spyOn(publicChatApi, 'startPublicConversation').mockResolvedValueOnce({
      conversation: {
        id: 'conv-waiting-303',
        botId: 'bot-1',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
      },
      visitorToken: 'token-303',
      sessionSecret: 'secret-303',
    });

    render(<CustomerChatWidget botId="bot-1" defaultOpen={true} />);

    await waitFor(() => {
      expect(screen.queryByText('Starting conversation...')).toBeNull();
    });

    // Banner should not be visible while ACTIVE
    expect(screen.queryByText(/Waiting for an available specialist/i)).toBeNull();

    // Wait for the socket useEffect to register the escalation listener
    await waitFor(() => {
      expect(socketListeners['conversation:escalated']?.length).toBeGreaterThan(0);
    });

    // Trigger escalation realtime event from server
    act(() => {
      socketListeners['conversation:escalated']?.forEach((fn) => fn({ conversationId: 'conv-waiting-303' }));
    });

    // Waiting banner must appear
    expect(await screen.findByText(/Waiting for an available specialist/i)).toBeDefined();
    expect(
      await screen.findByText(/Connecting you with a support specialist. We will reply here shortly/i),
    ).toBeDefined();
  });

  it('renders received agent message in real time', async () => {
    vi.spyOn(publicChatApi, 'startPublicConversation').mockResolvedValueOnce({
      conversation: {
        id: 'conv-agent-404',
        botId: 'bot-1',
        status: 'HUMAN_ACTIVE',
        createdAt: new Date().toISOString(),
      },
      visitorToken: 'token-404',
      sessionSecret: 'secret-404',
    });

    render(<CustomerChatWidget botId="bot-1" defaultOpen={true} />);

    await waitFor(() => {
      expect(screen.queryByText('Starting conversation...')).toBeNull();
    });

    // Simulate incoming agent reply via socket
    act(() => {
      socketListeners['message:new']?.forEach((fn) =>
        fn({
          id: 'msg-agent-999',
          conversationId: 'conv-agent-404',
          role: 'AGENT',
          content: 'Hi! I am Jane from support. I see your request and am looking into it.',
          createdAt: new Date().toISOString(),
        }),
      );
    });

    // Check that message and agent role badge are rendered
    expect(
      await screen.findByText('Hi! I am Jane from support. I see your request and am looking into it.'),
    ).toBeDefined();
    expect(await screen.findByText('Support Specialist')).toBeDefined();
  });

  it('allows customer to submit a message and reconciles reply', async () => {
    vi.spyOn(publicChatApi, 'startPublicConversation').mockResolvedValueOnce({
      conversation: {
        id: 'conv-send-505',
        botId: 'bot-1',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
      },
      visitorToken: 'token-505',
      sessionSecret: 'secret-505',
    });

    const sendSpy = vi.spyOn(publicChatApi, 'sendPublicMessage').mockResolvedValueOnce({
      userMessage: {
        id: 'msg-user-1',
        role: 'USER',
        content: 'Can you help me with billing?',
        createdAt: new Date().toISOString(),
      },
      assistantMessage: {
        id: 'msg-ai-1',
        role: 'ASSISTANT',
        content: 'Sure! What billing question do you have?',
        createdAt: new Date().toISOString(),
      },
      suppressed: false,
    });

    render(<CustomerChatWidget botId="bot-1" defaultOpen={true} />);

    await waitFor(() => {
      expect(screen.queryByText('Starting conversation...')).toBeNull();
    });

    const input = screen.getByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'Can you help me with billing?' } });

    const submitBtn = screen.getByRole('button', { name: 'Send message' });
    fireEvent.click(submitBtn);

    // Verify optimistic user message immediately in DOM
    expect(screen.getByText('Can you help me with billing?')).toBeDefined();

    await waitFor(() => {
      expect(sendSpy).toHaveBeenCalledWith(
        'conv-send-505',
        'token-505',
        'Can you help me with billing?',
        expect.any(String),
      );
    });

    // Assistant response displayed
    expect(await screen.findByText('Sure! What billing question do you have?')).toBeDefined();
  });

  it('handles message sent when chat is controlled by human (suppressed AI_BYPASSED response)', async () => {
    vi.spyOn(publicChatApi, 'startPublicConversation').mockResolvedValueOnce({
      conversation: {
        id: 'conv-suppressed-506',
        botId: 'bot-1',
        status: 'HUMAN_ACTIVE',
        createdAt: new Date().toISOString(),
      },
      visitorToken: 'token-506',
      sessionSecret: 'secret-506',
    });

    const sendSpy = vi.spyOn(publicChatApi, 'sendPublicMessage').mockResolvedValueOnce({
      userMessage: {
        id: 'msg-user-suppressed',
        role: 'USER',
        content: 'help me',
        createdAt: new Date().toISOString(),
      },
      assistantMessage: null,
      suppressed: true,
      suppressionReason: 'AI_BYPASSED',
    });

    render(<CustomerChatWidget botId="bot-1" defaultOpen={true} />);

    await waitFor(() => {
      expect(screen.queryByText('Starting conversation...')).toBeNull();
    });

    const input = screen.getByPlaceholderText('Type a message...');
    fireEvent.change(input, { target: { value: 'help me' } });

    const submitBtn = screen.getByRole('button', { name: 'Send message' });
    fireEvent.click(submitBtn);

    // Verify user message is committed and displayed in DOM
    await waitFor(() => {
      expect(sendSpy).toHaveBeenCalled();
    });
    expect(screen.getByText('help me')).toBeDefined();

    // No error banner should be displayed
    expect(screen.queryByText(/Failed to send message/i)).toBeNull();
  });

  it('renders standalone widget page correctly', async () => {
    vi.spyOn(publicChatApi, 'startPublicConversation').mockResolvedValueOnce({
      conversation: {
        id: 'conv-standalone-606',
        botId: 'bot-1',
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
      },
      visitorToken: 'token-606',
      sessionSecret: 'secret-606',
    });

    render(<StandaloneWidgetPage />);

    // In standalone mode, widget is open by default and does not render floating launcher
    expect(screen.queryByLabelText('Open chat support')).toBeNull();
    expect(await screen.findByText('Support Assistant')).toBeDefined();
  });
});
