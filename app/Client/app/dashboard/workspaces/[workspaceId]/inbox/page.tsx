'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Wifi,
  WifiOff,
  Inbox,
  User,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/toast';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api-client';

import { getWorkspace, type WorkspaceDetail } from '@/lib/api/workspaces';
import { listBots, type Bot } from '@/lib/api/bots';
import {
  fetchQueue,
  getConversation,
  claimConversation,
  unassignConversation,
  resolveConversation,
  reopenConversation,
  sendAgentReply,
  type QueueItem,
  type QueueView,
  type Conversation,
  type Message,
} from '@/lib/api/conversations';
import {
  getSocket,
  workspaceQueueRoom,
  conversationRoom,
  joinRoom,
  leaveRoom,
  type RealtimeMessage,
  type RealtimeConversationEvent,
  type RealtimeQueueUpdate,
} from '@/lib/socket';

import { QueueSidebar } from './_components/queue-sidebar';
import { ConversationCard } from './_components/conversation-card';
import { TranscriptView } from './_components/transcript-view';
import { AgentComposer } from './_components/agent-composer';
import { AssignModal } from './_components/assign-modal';
import { ContactPanel } from './_components/contact-panel';

export default function WorkspaceInboxPage() {
  const params = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const { toast } = useToast();

  const workspaceId = params.workspaceId;

  // Workspace & Bots
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);

  // Queue state
  const [currentView, setCurrentView] = useState<QueueView>('unassigned');
  const [selectedBotId, setSelectedBotId] = useState<string | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState('');
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [counts, setCounts] = useState<Record<QueueView, number>>({
    unassigned: 0,
    assigned: 0,
    all_active: 0,
    resolved: 0,
  });

  // Selected Conversation state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // UI Panels
  const [showInspector, setShowInspector] = useState(true);
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);

  const activeConvRef = useRef<string | null>(null);
  activeConvRef.current = selectedId;

  // Load Workspace & Bots baseline
  useEffect(() => {
    async function loadInitial() {
      try {
        const [ws, botList] = await Promise.all([
          getWorkspace(workspaceId),
          listBots(workspaceId),
        ]);
        setWorkspace(ws);
        setBots(botList);
      } catch {
        toast('Failed to load workspace data', 'error');
        router.push('/dashboard/workspaces');
      } finally {
        setLoading(false);
      }
    }
    loadInitial();
  }, [workspaceId, router, toast]);

  // Load Queue Items
  const loadQueue = useCallback(async () => {
    if (!workspaceId) return;
    setQueueLoading(true);
    try {
      const result = await fetchQueue(workspaceId, {
        view: currentView,
        botId: selectedBotId,
      });
      setQueueItems(result.items);

      // Refresh badge counts
      const [unassignedRes, assignedRes] = await Promise.all([
        fetchQueue(workspaceId, { view: 'unassigned', limit: 100 }),
        fetchQueue(workspaceId, { view: 'assigned', limit: 100 }),
      ]);
      setCounts((prev) => ({
        ...prev,
        unassigned: unassignedRes.items.length,
        assigned: assignedRes.items.length,
        [currentView]: result.items.length,
      }));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to fetch queue', 'error');
    } finally {
      setQueueLoading(false);
    }
  }, [workspaceId, currentView, selectedBotId, toast]);

  useEffect(() => {
    if (!loading) {
      loadQueue();
    }
  }, [loading, loadQueue]);

  // Load Active Conversation Detail
  const loadConversationDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        const data = await getConversation(id);
        setActiveConversation(data);
        setMessages(data.messages || []);
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Failed to load conversation', 'error');
      } finally {
        setDetailLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    if (selectedId) {
      loadConversationDetail(selectedId);
    } else {
      setActiveConversation(null);
      setMessages([]);
    }
  }, [selectedId, loadConversationDetail]);

  // Realtime Socket Connection and Events
  useEffect(() => {
    if (!workspaceId) return;

    const socket = getSocket();

    function onConnect() {
      setSocketConnected(true);
      // Join workspace queue room
      const qRoom = workspaceQueueRoom(workspaceId);
      joinRoom(socket, qRoom);
    }

    function onDisconnect() {
      setSocketConnected(false);
    }

    function onQueueUpdated(_payload: RealtimeQueueUpdate) {
      loadQueue();
    }

    function onConversationLifecycleEvent(eventPayload: RealtimeConversationEvent) {
      loadQueue();
      if (activeConvRef.current === eventPayload.conversationId) {
        setActiveConversation((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            status: eventPayload.status,
            assignedAgentId: eventPayload.assignedAgentId,
            version: eventPayload.version ?? prev.version,
          };
        });
      }
    }

    function onMessageNew(msg: RealtimeMessage) {
      if (activeConvRef.current === msg.conversationId) {
        setMessages((prev) => {
          // Reconcile optimistic message by clientMessageId
          if (msg.clientMessageId) {
            const index = prev.findIndex((m) => m.clientMessageId === msg.clientMessageId);
            if (index !== -1) {
              const updated = [...prev];
              updated[index] = {
                ...updated[index],
                id: msg.id,
                createdAt: msg.createdAt,
                senderId: msg.senderId ?? updated[index].senderId,
              };
              return updated;
            }
          }

          // Avoid duplicate by id
          if (prev.some((m) => m.id === msg.id)) {
            return prev;
          }

          return [
            ...prev,
            {
              id: msg.id,
              conversationId: msg.conversationId,
              role: msg.role,
              content: msg.content,
              createdAt: msg.createdAt,
              clientMessageId: msg.clientMessageId,
              senderId: msg.senderId,
            },
          ];
        });
      }

      // Also update last message preview in queue items
      setQueueItems((prev) =>
        prev.map((item) => {
          if (item.id === msg.conversationId) {
            return {
              ...item,
              updatedAt: msg.createdAt,
              messages: [{ role: msg.role, content: msg.content, createdAt: msg.createdAt }],
            };
          }
          return item;
        }),
      );
    }

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('queue:updated', onQueueUpdated);
    socket.on('conversation:claimed', onConversationLifecycleEvent);
    socket.on('conversation:assigned', onConversationLifecycleEvent);
    socket.on('conversation:unassigned', onConversationLifecycleEvent);
    socket.on('conversation:resolved', onConversationLifecycleEvent);
    socket.on('conversation:reopened', onConversationLifecycleEvent);
    socket.on('message:new', onMessageNew);

    if (socket.connected) {
      onConnect();
    } else {
      socket.connect();
    }

    return () => {
      const qRoom = workspaceQueueRoom(workspaceId);
      leaveRoom(socket, qRoom);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('queue:updated', onQueueUpdated);
      socket.off('conversation:claimed', onConversationLifecycleEvent);
      socket.off('conversation:assigned', onConversationLifecycleEvent);
      socket.off('conversation:unassigned', onConversationLifecycleEvent);
      socket.off('conversation:resolved', onConversationLifecycleEvent);
      socket.off('conversation:reopened', onConversationLifecycleEvent);
      socket.off('message:new', onMessageNew);
    };
  }, [workspaceId, loadQueue]);

  // Join/Leave active conversation room
  useEffect(() => {
    if (!selectedId) return;
    const socket = getSocket();
    const cRoom = conversationRoom(selectedId);
    joinRoom(socket, cRoom);

    return () => {
      leaveRoom(socket, cRoom);
    };
  }, [selectedId]);

  // Lifecycle actions
  async function handleClaim() {
    if (!selectedId || !user) return;
    setActionLoading(true);

    // Optimistic UI update
    const prevConversation = activeConversation;
    setActiveConversation((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        status: 'HUMAN_ACTIVE',
        assignedAgentId: user.id,
        assignedAgent: { id: user.id, name: user.name },
      };
    });

    try {
      const updated = await claimConversation(selectedId);
      setActiveConversation(updated);
      toast('Conversation claimed', 'success');
      loadQueue();
    } catch (err) {
      // Revert optimistic update
      setActiveConversation(prevConversation);
      if (err instanceof ApiError && err.status === 409) {
        toast('This ticket was just claimed by another agent', 'error');
      } else {
        toast(err instanceof ApiError ? err.message : 'Failed to claim conversation', 'error');
      }
      loadQueue();
    } finally {
      setActionLoading(false);
    }
  }

  async function handleUnassign() {
    if (!selectedId) return;
    setActionLoading(true);

    try {
      const updated = await unassignConversation(selectedId);
      setActiveConversation(updated);
      toast('Conversation returned to queue', 'success');
      loadQueue();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to unassign', 'error');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleResolve() {
    if (!selectedId) return;
    setActionLoading(true);

    try {
      const updated = await resolveConversation(selectedId);
      setActiveConversation(updated);
      toast('Conversation marked resolved', 'success');
      loadQueue();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to resolve', 'error');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleReopen() {
    if (!selectedId) return;
    setActionLoading(true);

    try {
      const updated = await reopenConversation(selectedId);
      setActiveConversation(updated);
      toast('Conversation reopened', 'success');
      loadQueue();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to reopen', 'error');
    } finally {
      setActionLoading(false);
    }
  }

  // Send agent reply with optimistic update
  async function handleSendReply(content: string) {
    if (!selectedId || !user) return;

    const tempClientMessageId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const optimisticMsg: Message = {
      id: tempClientMessageId,
      conversationId: selectedId,
      role: 'AGENT',
      content,
      createdAt: new Date().toISOString(),
      clientMessageId: tempClientMessageId,
      senderId: user.id,
    };

    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const res = await sendAgentReply(selectedId, content);
      // Reconcile optimistic message
      setMessages((prev) =>
        prev.map((m) =>
          m.clientMessageId === tempClientMessageId ? res.message : m,
        ),
      );
    } catch (err) {
      // Remove failed optimistic message
      setMessages((prev) => prev.filter((m) => m.clientMessageId !== tempClientMessageId));
      toast(err instanceof ApiError ? err.message : 'Failed to send reply', 'error');
      throw err;
    }
  }

  const isOwnerOrAdmin =
    workspace?.viewerRole === 'OWNER' || workspace?.viewerRole === 'ADMIN';

  const filteredQueueItems = queueItems.filter((item) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    const idMatch = item.id.toLowerCase().includes(query);
    const botMatch = item.bot?.name.toLowerCase().includes(query);
    const reasonMatch = item.escalationReason?.toLowerCase().includes(query);
    const messageMatch = item.messages?.some((m) => m.content.toLowerCase().includes(query));
    return idMatch || botMatch || reasonMatch || messageMatch;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] -m-4 sm:-m-6 lg:-m-8 overflow-hidden bg-background">
      {/* Top Header Bar */}
      <header className="px-4 py-2.5 border-b border-border bg-card flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Link
            href={`/dashboard/workspaces/${workspaceId}`}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>{workspace?.name}</span>
          </Link>
          <span className="text-muted-foreground">•</span>
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-foreground">Support Inbox</h1>
            <span
              className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium ${
                socketConnected
                  ? 'bg-success/15 text-success'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {socketConnected ? (
                <>
                  <Wifi className="h-2.5 w-2.5" />
                  Live
                </>
              ) : (
                <>
                  <WifiOff className="h-2.5 w-2.5" />
                  Connecting
                </>
              )}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={loadQueue}
            disabled={queueLoading}
            title="Refresh queue"
            className="h-8 w-8 p-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${queueLoading ? 'animate-spin' : ''}`} />
          </Button>

          {selectedId && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowInspector((prev) => !prev)}
              className="text-xs h-8"
            >
              {showInspector ? (
                <>
                  <PanelRightClose className="h-3.5 w-3.5 mr-1" />
                  Hide Info
                </>
              ) : (
                <>
                  <PanelRightOpen className="h-3.5 w-3.5 mr-1" />
                  Show Info
                </>
              )}
            </Button>
          )}
        </div>
      </header>

      {/* Main 3-Panel Content Area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Panel 1: Queue Sidebar */}
        <aside className="w-56 border-r border-border bg-sidebar/50 p-3 hidden md:flex flex-col shrink-0 overflow-y-auto">
          <QueueSidebar
            currentView={currentView}
            onViewChange={(view) => {
              setCurrentView(view);
              setSelectedId(null);
            }}
            counts={counts}
            bots={bots}
            selectedBotId={selectedBotId}
            onBotChange={setSelectedBotId}
          />
        </aside>

        {/* Panel 2: Conversation List */}
        <section className="w-80 border-r border-border bg-card flex flex-col shrink-0 min-w-0">
          <div className="p-3 border-b border-border space-y-2">
            <div className="relative">
              <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-2.5 pointer-events-none" />
              <Input
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 text-xs h-8"
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground px-1">
              <span>{filteredQueueItems.length} conversation(s)</span>
              <span className="capitalize">{currentView.replace('_', ' ')}</span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {queueLoading && queueItems.length === 0 ? (
              <div className="flex justify-center py-12">
                <Spinner size="md" />
              </div>
            ) : filteredQueueItems.length === 0 ? (
              <div className="py-12 text-center px-4">
                <Inbox className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
                <p className="text-xs font-medium text-foreground">No conversations found</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {currentView === 'unassigned'
                    ? 'All escalated tickets have been claimed!'
                    : 'No tickets in this view.'}
                </p>
              </div>
            ) : (
              filteredQueueItems.map((item) => (
                <ConversationCard
                  key={item.id}
                  item={item}
                  selected={selectedId === item.id}
                  onClick={() => setSelectedId(item.id)}
                />
              ))
            )}
          </div>
        </section>

        {/* Panel 3: Active Conversation Transcript & Composer */}
        <main className="flex-1 flex min-w-0 overflow-hidden bg-background">
          {selectedId && activeConversation ? (
            <div className="flex flex-1 min-w-0 overflow-hidden">
              <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
                {detailLoading ? (
                  <div className="flex items-center justify-center flex-1">
                    <Spinner size="lg" />
                  </div>
                ) : (
                  <>
                    <TranscriptView
                      conversation={activeConversation}
                      messages={messages}
                      currentUserId={user?.id}
                      isOwnerOrAdmin={isOwnerOrAdmin}
                      onClaim={handleClaim}
                      onUnassign={handleUnassign}
                      onResolve={handleResolve}
                      onReopen={handleReopen}
                      onOpenAssignModal={() => setAssignModalOpen(true)}
                      actionLoading={actionLoading}
                    />

                    <AgentComposer
                      onSend={handleSendReply}
                      status={activeConversation.status}
                      isAssignedToCurrentUser={activeConversation.assignedAgentId === user?.id}
                      onClaim={handleClaim}
                      onReopen={handleReopen}
                    />
                  </>
                )}
              </div>

              {/* Inspector Panel */}
              {showInspector && (
                <ContactPanel
                  conversation={activeConversation}
                  contact={activeConversation.contact}
                />
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 text-center p-8">
              <div className="h-12 w-12 rounded-2xl bg-muted flex items-center justify-center mb-3">
                <Inbox className="h-6 w-6 text-muted-foreground" />
              </div>
              <h2 className="text-sm font-semibold text-foreground">Select a conversation</h2>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                Choose a conversation from the queue on the left to review the transcript, claim the ticket, or reply to the customer.
              </p>
            </div>
          )}
        </main>
      </div>

      {/* Assignment Modal */}
      {selectedId && (
        <AssignModal
          open={assignModalOpen}
          onClose={() => setAssignModalOpen(false)}
          workspaceId={workspaceId}
          conversationId={selectedId}
          currentAgentId={activeConversation?.assignedAgentId}
          onAssigned={(updated) => {
            setActiveConversation(updated);
            toast('Conversation assigned successfully', 'success');
            loadQueue();
          }}
        />
      )}
    </div>
  );
}
