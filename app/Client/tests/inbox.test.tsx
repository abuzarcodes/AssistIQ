import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import type { QueueItem, Conversation } from '@/lib/api/conversations';

// Mock Next.js navigation
vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws-123' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard/workspaces/ws-123/inbox',
}));

// Mock Auth Context
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'agent-1', name: 'Support Agent Jane', email: 'jane@example.com' },
    hasPermission: () => true,
    logout: vi.fn(),
  }),
}));

// Mock Socket
const socketListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
const mockSocket = {
  connected: true,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!socketListeners[event]) socketListeners[event] = [];
    socketListeners[event].push(handler);
  }),
  off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (socketListeners[event]) {
      socketListeners[event] = socketListeners[event].filter((h) => h !== handler);
    }
  }),
  emit: vi.fn(),
};

vi.mock('@/lib/socket', () => ({
  getSocket: () => mockSocket,
  workspaceQueueRoom: (ws: string) => `workspace:${ws}:queue`,
  conversationRoom: (c: string) => `conversation:${c}`,
  joinRoom: vi.fn().mockResolvedValue({ ok: true }),
  leaveRoom: vi.fn().mockResolvedValue({ ok: true }),
}));

// Mock Workspaces API
vi.mock('@/lib/api/workspaces', () => ({
  getWorkspace: vi.fn().mockResolvedValue({
    id: 'ws-123',
    name: 'Acme Support',
    ownerId: 'owner-1',
    viewerRole: 'ADMIN',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  listWorkspaceMembers: vi.fn().mockResolvedValue([
    {
      id: 'm-1',
      workspaceId: 'ws-123',
      userId: 'agent-1',
      role: 'AGENT',
      user: { id: 'agent-1', name: 'Support Agent Jane', email: 'jane@example.com', platformRole: 'USER' },
    },
    {
      id: 'm-2',
      workspaceId: 'ws-123',
      userId: 'agent-2',
      role: 'AGENT',
      user: { id: 'agent-2', name: 'Agent Bob', email: 'bob@example.com', platformRole: 'USER' },
    },
  ]),
}));

// Mock Bots API
vi.mock('@/lib/api/bots', () => ({
  listBots: vi.fn().mockResolvedValue([
    { id: 'bot-1', name: 'HelpBot', workspaceId: 'ws-123' },
  ]),
}));

// Mock Conversations API
const fetchQueueMock = vi.fn();
const getConversationMock = vi.fn();
const claimConversationMock = vi.fn();
const assignConversationMock = vi.fn();
const unassignConversationMock = vi.fn();
const resolveConversationMock = vi.fn();
const reopenConversationMock = vi.fn();
const sendAgentReplyMock = vi.fn();
const listConversationEventsMock = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/api/conversations', () => ({
  fetchQueue: (...args: unknown[]) => fetchQueueMock(...args),
  getConversation: (...args: unknown[]) => getConversationMock(...args),
  claimConversation: (...args: unknown[]) => claimConversationMock(...args),
  assignConversation: (...args: unknown[]) => assignConversationMock(...args),
  unassignConversation: (...args: unknown[]) => unassignConversationMock(...args),
  resolveConversation: (...args: unknown[]) => resolveConversationMock(...args),
  reopenConversation: (...args: unknown[]) => reopenConversationMock(...args),
  sendAgentReply: (...args: unknown[]) => sendAgentReplyMock(...args),
  listConversationEvents: (...args: unknown[]) => listConversationEventsMock(...args),
}));

const WorkspaceInboxPage = (
  await import(
    '@/app/dashboard/workspaces/[workspaceId]/inbox/page'
  )
).default;

const mockQueueItem: QueueItem = {
  id: 'conv-11111111-1111-1111-1111-111111111111',
  botId: 'bot-1',
  workspaceId: 'ws-123',
  status: 'WAITING_FOR_HUMAN',
  assignedAgentId: null,
  escalatedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(), // 3 mins ago
  escalationReason: 'HUMAN_REQUESTED',
  escalatedOffHours: false,
  resolvedAt: null,
  version: 1,
  createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  updatedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
  bot: { id: 'bot-1', name: 'HelpBot' },
  assignedAgent: null,
  messages: [
    {
      role: 'USER',
      content: 'I need to speak with a human support agent.',
      createdAt: new Date().toISOString(),
    },
  ],
};

const mockConversationDetail: Conversation = {
  id: 'conv-11111111-1111-1111-1111-111111111111',
  botId: 'bot-1',
  workspaceId: 'ws-123',
  status: 'WAITING_FOR_HUMAN',
  assignedAgentId: null,
  escalatedAt: new Date().toISOString(),
  escalationReason: 'HUMAN_REQUESTED',
  escalatedOffHours: false,
  resolvedAt: null,
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  bot: { id: 'bot-1', name: 'HelpBot' },
  assignedAgent: null,
  contact: {
    name: 'Alice Johnson',
    email: 'alice@example.com',
    phone: '+1 555-0199',
    orderId: 'ORD-9921',
  },
  messages: [
    {
      id: 'msg-1',
      conversationId: 'conv-11111111-1111-1111-1111-111111111111',
      role: 'USER',
      content: 'Can you help me with my return?',
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    },
    {
      id: 'msg-2',
      conversationId: 'conv-11111111-1111-1111-1111-111111111111',
      role: 'ASSISTANT',
      content: 'Let me connect you to a human agent.',
      createdAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    },
    {
      id: 'msg-3',
      conversationId: 'conv-11111111-1111-1111-1111-111111111111',
      role: 'USER',
      content: 'I need to speak with a human support agent.',
      createdAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    },
  ],
};

describe('Support Agent Inbox Dashboard (CP5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(socketListeners).forEach((k) => delete socketListeners[k]);

    fetchQueueMock.mockResolvedValue({
      items: [mockQueueItem],
      pagination: { limit: 25, hasMore: false },
    });

    getConversationMock.mockResolvedValue(mockConversationDetail);
  });

  it('renders queue items with waiting duration badge, bot name, and status', async () => {
    render(
      <ToastProvider>
        <WorkspaceInboxPage />
      </ToastProvider>,
    );

    // Verify inbox header
    await waitFor(() => {
      expect(screen.getByText('Support Inbox')).toBeInTheDocument();
    });

    // Verify conversation card renders visitor, bot name, and snippet
    await waitFor(() => {
      expect(screen.getByText('Visitor #conv-1')).toBeInTheDocument();
      expect(screen.getAllByText('HelpBot')[0]).toBeInTheDocument();
      expect(screen.getByText(/I need to speak with a human support agent/)).toBeInTheDocument();
      expect(screen.getByText('Waiting')).toBeInTheDocument();
      expect(screen.getByText('< 5m')).toBeInTheDocument();
    });
  });

  it('claims an unassigned conversation and updates UI to HUMAN_ACTIVE', async () => {
    claimConversationMock.mockResolvedValue({
      ...mockConversationDetail,
      status: 'HUMAN_ACTIVE',
      assignedAgentId: 'agent-1',
      assignedAgent: { id: 'agent-1', name: 'Support Agent Jane' },
    });

    render(
      <ToastProvider>
        <WorkspaceInboxPage />
      </ToastProvider>,
    );

    // Select the conversation card
    await waitFor(() => {
      expect(screen.getByText('Visitor #conv-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Visitor #conv-1'));

    // Wait for conversation transcript to load
    await waitFor(() => {
      expect(screen.getAllByText('Alice Johnson')[0]).toBeInTheDocument();
      expect(screen.getByText('Can you help me with my return?')).toBeInTheDocument();
    });

    // Find and click Claim button (header or composer banner)
    const claimButtons = screen.getAllByRole('button', { name: /Claim/i });
    expect(claimButtons.length).toBeGreaterThan(0);
    fireEvent.click(claimButtons[0]);

    await waitFor(() => {
      expect(claimConversationMock).toHaveBeenCalledWith(mockQueueItem.id);
      expect(screen.getByText('Conversation claimed')).toBeInTheDocument();
    });
  });

  it('handles claim conflict error (409) gracefully with informative toast', async () => {
    claimConversationMock.mockRejectedValue(
      new ApiError('Conversation already claimed', 409),
    );

    render(
      <ToastProvider>
        <WorkspaceInboxPage />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Visitor #conv-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Visitor #conv-1'));

    await waitFor(() => {
      expect(screen.getAllByText('Alice Johnson')[0]).toBeInTheDocument();
    });

    const claimButtons = screen.getAllByRole('button', { name: /Claim/i });
    fireEvent.click(claimButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByText('This ticket was just claimed by another agent'),
      ).toBeInTheDocument();
    });
  });

  it('types and sends an agent reply, appending message to transcript', async () => {
    // Prime conversation as already claimed by current agent
    getConversationMock.mockResolvedValue({
      ...mockConversationDetail,
      status: 'HUMAN_ACTIVE',
      assignedAgentId: 'agent-1',
      assignedAgent: { id: 'agent-1', name: 'Support Agent Jane' },
    });

    const replyText = 'Hello Alice, I can certainly help you with your return!';
    sendAgentReplyMock.mockResolvedValue({
      message: {
        id: 'msg-agent-reply-1',
        conversationId: mockQueueItem.id,
        role: 'AGENT',
        content: replyText,
        createdAt: new Date().toISOString(),
        senderId: 'agent-1',
      },
    });

    render(
      <ToastProvider>
        <WorkspaceInboxPage />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Visitor #conv-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Visitor #conv-1'));

    await waitFor(() => {
      expect(screen.getAllByText('Alice Johnson')[0]).toBeInTheDocument();
    });

    // Type reply into textarea
    const textarea = screen.getByPlaceholderText(/Reply as support agent/i);
    fireEvent.change(textarea, { target: { value: replyText } });

    // Click Send button
    const sendButton = screen.getByRole('button', { name: /Send/i });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(sendAgentReplyMock).toHaveBeenCalledWith(mockQueueItem.id, replyText);
      expect(screen.getByText(replyText)).toBeInTheDocument();
    });
  });

  it('appends incoming realtime message to transcript via message:new socket event', async () => {
    render(
      <ToastProvider>
        <WorkspaceInboxPage />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Visitor #conv-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Visitor #conv-1'));

    await waitFor(() => {
      expect(screen.getAllByText('Alice Johnson')[0]).toBeInTheDocument();
    });


    // Simulate incoming customer message via realtime
    const incomingText = 'My tracking number is TRK-123456';
    const messageNewHandlers = socketListeners['message:new'] || [];
    expect(messageNewHandlers.length).toBeGreaterThan(0);

    await act(async () => {
      messageNewHandlers.forEach((handler) =>
        handler({
          id: 'msg-new-rt-1',
          conversationId: mockQueueItem.id,
          role: 'USER',
          content: incomingText,
          createdAt: new Date().toISOString(),
          clientMessageId: null,
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getAllByText(incomingText).length).toBeGreaterThanOrEqual(1);
    });
  });



  it('switches queue views between Unassigned and Resolved tabs', async () => {
    render(
      <ToastProvider>
        <WorkspaceInboxPage />
      </ToastProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Unassigned')).toBeInTheDocument();
      expect(screen.getByText('Resolved')).toBeInTheDocument();
    });

    // Click Resolved tab
    fireEvent.click(screen.getByText('Resolved'));

    await waitFor(() => {
      expect(fetchQueueMock).toHaveBeenCalledWith(
        'ws-123',
        expect.objectContaining({ view: 'resolved' }),
      );
    });
  });
});
