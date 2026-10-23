'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Inbox,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Search,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useToast } from '@/components/ui/toast';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api-client';
import { useWorkspace } from '@/lib/workspace-context';

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
} from '@/lib/socket';

import { QueueSidebar } from './_components/queue-sidebar';
import { ConversationCard } from './_components/conversation-card';
import { TranscriptView } from './_components/transcript-view';
import { AgentComposer } from './_components/agent-composer';
import { AssignModal } from './_components/assign-modal';
import { ContactPanel } from './_components/contact-panel';

const QUEUE_VIEWS: { value: QueueView; label: string }[] = [
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'assigned', label: 'My assigned' },
  { value: 'all_active', label: 'All active' },
  { value: 'resolved', label: 'Resolved' },
];

/**
 * The workspace support inbox (CP8).
 *
 * This is the working surface, not a dashboard: a queue rail, the conversation
 * list and the transcript share one quiet card. The inspector stays out of the
 * way until it is opened, and becomes a slide-over below the wide desktop where
 * three columns would leave the transcript too narrow.
 */
export default function WorkspaceInboxPage() {
  const { workspaceId, workspace } = useWorkspace();
  const { user } = useAuth();
  const { toast } = useToast();

  // Bots available to the queue's bot filter.
  const [bots, setBots] = useState<Bot[]>([]);

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

  // Selected conversation state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Panels
  const [showInspector, setShowInspector] = useState(false);
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);

  const activeConvRef = useRef<string | null>(null);
  const didAutoSelectRef = useRef(false);
  const queueRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  useEffect(() => {
    activeConvRef.current = selectedId;
  }, [selectedId]);

  // The shell already owns the workspace request; only the bot filter is new here.
  useEffect(() => {
    let cancelled = false;

    listBots(workspaceId)
      .then((list) => {
        if (!cancelled) setBots(list);
      })
      .catch(() => {
        if (!cancelled) toast('Failed to load the bot filter', 'error');
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, toast]);

  const loadQueue = useCallback(async () => {
    if (!workspaceId) return;

    // A socket update and a view switch can start two queue fetches at once.
    // Only the newest response may write, or an older response can put the
    // previous view back on screen.
    const requestId = queueRequestRef.current + 1;
    queueRequestRef.current = requestId;
    setQueueLoading(true);

    try {
      const result = await fetchQueue(workspaceId, {
        view: currentView,
        botId: selectedBotId,
      });
      if (queueRequestRef.current !== requestId) return;
      setQueueItems(result.items);

      // Open the first conversation on desktop so the transcript is not blank
      // on load. Phones start on the list: opening straight into one ticket
      // hides the queue and gives the agent no way back.
      const canAutoSelect =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(min-width: 768px)').matches
          : false;
      if (!didAutoSelectRef.current && canAutoSelect && result.items.length > 0) {
        didAutoSelectRef.current = true;
        setSelectedId(result.items[0].id);
      }

      // Refresh the badge counts for the two views that are always visible.
      const [unassignedRes, assignedRes] = await Promise.all([
        fetchQueue(workspaceId, { view: 'unassigned', limit: 100 }),
        fetchQueue(workspaceId, { view: 'assigned', limit: 100 }),
      ]);
      if (queueRequestRef.current !== requestId) return;
      setCounts((prev) => ({
        ...prev,
        unassigned: unassignedRes.items.length,
        assigned: assignedRes.items.length,
        [currentView]: result.items.length,
      }));
    } catch (err) {
      if (queueRequestRef.current !== requestId) return;
      toast(err instanceof ApiError ? err.message : 'Failed to fetch the queue', 'error');
    } finally {
      if (queueRequestRef.current === requestId) {
        setQueueLoading(false);
      }
    }
  }, [workspaceId, currentView, selectedBotId, toast]);

  useEffect(() => {
    // Queue loading is a data subscription; the loading flag is the intended sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadQueue();
  }, [loadQueue]);

  const loadConversationDetail = useCallback(
    async (id: string) => {
      const requestId = detailRequestRef.current + 1;
      detailRequestRef.current = requestId;
      setDetailLoading(true);
      try {
        const data = await getConversation(id);
        if (detailRequestRef.current !== requestId) return;
        setActiveConversation(data);
        setMessages(data.messages || []);
      } catch (err) {
        if (detailRequestRef.current !== requestId) return;
        toast(err instanceof ApiError ? err.message : 'Failed to load the conversation', 'error');
      } finally {
        if (detailRequestRef.current === requestId) {
          setDetailLoading(false);
        }
      }
    },
    [toast],
  );

  useEffect(() => {
    if (selectedId) {
      // Conversation detail is a data subscription; the detail flag is its sync.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadConversationDetail(selectedId);
    } else {
      detailRequestRef.current += 1;
      setActiveConversation(null);
      setMessages([]);
    }
  }, [selectedId, loadConversationDetail]);

  // Realtime socket connection and queue events.
  useEffect(() => {
    if (!workspaceId) return;

    const socket = getSocket();

    function onConnect() {
      setSocketConnected(true);
      joinRoom(socket, workspaceQueueRoom(workspaceId));
    }

    function onDisconnect() {
      setSocketConnected(false);
    }

    function onQueueUpdated() {
      void loadQueue();
    }

    function onConversationLifecycleEvent(eventPayload: RealtimeConversationEvent) {
      void loadQueue();
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
          // The HTTP reply response and the socket echo can arrive in either
          // order. Never render the same durable message twice.
          if (prev.some((entry) => entry.id === msg.id)) {
            return prev;
          }

          // Agent replies carry no clientMessageId in the socket payload, so
          // match the optimistic pending row by its content before appending.
          // The HTTP response then replaces that same row without a flash.
          if (!msg.clientMessageId && msg.role === 'AGENT') {
            for (let index = prev.length - 1; index >= 0; index -= 1) {
              const entry = prev[index];
              if (
                entry.id.startsWith('temp-') &&
                entry.role === msg.role &&
                entry.senderId === msg.senderId &&
                entry.content === msg.content
              ) {
                const updated = [...prev];
                updated[index] = {
                  ...entry,
                  id: msg.id,
                  createdAt: msg.createdAt,
                };
                return updated;
              }
            }
          }

          // Reconcile the optimistic row by clientMessageId.
          if (msg.clientMessageId) {
            const index = prev.findIndex(
              (entry) => entry.clientMessageId === msg.clientMessageId,
            );
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

          if (prev.some((entry) => entry.id === msg.id)) return prev;

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

      setQueueItems((prev) =>
        prev.map((item) => {
          if (item.id !== msg.conversationId) return item;
          return {
            ...item,
            updatedAt: msg.createdAt,
            messages: [{ role: msg.role, content: msg.content, createdAt: msg.createdAt }],
          };
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
      leaveRoom(socket, workspaceQueueRoom(workspaceId));
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

  // Join and leave the selected conversation room.
  useEffect(() => {
    if (!selectedId) return;
    const socket = getSocket();
    const room = conversationRoom(selectedId);
    joinRoom(socket, room);

    return () => {
      leaveRoom(socket, room);
    };
  }, [selectedId]);

  async function handleClaim() {
    if (!selectedId || !user) return;
    setActionLoading(true);

    const previous = activeConversation;
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
      void loadQueue();
    } catch (err) {
      setActiveConversation(previous);
      if (err instanceof ApiError && err.status === 409) {
        toast('This ticket was just claimed by another agent', 'error');
      } else {
        toast(err instanceof ApiError ? err.message : 'Failed to claim conversation', 'error');
      }
      void loadQueue();
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
      toast('Conversation returned to the queue', 'success');
      void loadQueue();
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
      void loadQueue();
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
      void loadQueue();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to reopen', 'error');
    } finally {
      setActionLoading(false);
    }
  }

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
      setMessages((prev) => {
        const reconciled = prev.map((message) =>
          message.clientMessageId === tempClientMessageId ? res.message : message,
        );
        // The socket echo may have landed first and carries no clientMessageId
        // for an agent reply; keep one copy of the durable id either way.
        const seen = new Set<string>();
        return reconciled.filter((message) => {
          if (seen.has(message.id)) return false;
          seen.add(message.id);
          return true;
        });
      });
    } catch (err) {
      setMessages((prev) =>
        prev.filter((message) => message.clientMessageId !== tempClientMessageId),
      );
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
    const messageMatch = item.messages?.some((message) =>
      message.content.toLowerCase().includes(query),
    );
    return idMatch || botMatch || reasonMatch || messageMatch;
  });

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] min-h-[34rem] flex-col lg:h-[calc(100dvh-5.5rem)]">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Support Inbox
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Escalated conversations from every bot in {workspace?.name ?? 'this workspace'}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
              socketConnected
                ? 'bg-success-bg text-success-bg-foreground'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {socketConnected ? (
              <Wifi aria-hidden="true" className="h-3 w-3" />
            ) : (
              <WifiOff aria-hidden="true" className="h-3 w-3" />
            )}
            {socketConnected ? 'Live' : 'Connecting'}
          </span>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => void loadQueue()}
            disabled={queueLoading}
            aria-label="Refresh queue"
            className="h-8 w-8 p-0"
          >
            <RefreshCw
              aria-hidden="true"
              className={`h-3.5 w-3.5 ${queueLoading ? 'animate-spin' : ''}`}
            />
          </Button>

          {selectedId && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowInspector((prev) => !prev)}
              aria-expanded={showInspector}
              className="h-8 gap-1.5 text-xs"
            >
              {showInspector ? (
                <PanelRightClose aria-hidden="true" className="h-3.5 w-3.5" />
              ) : (
                <PanelRightOpen aria-hidden="true" className="h-3.5 w-3.5" />
              )}
              {showInspector ? 'Hide info' : 'Info'}
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card md:flex-row">
        {/* Queue rail: wide desktop only. Narrower layouts use the compact selects below. */}
        <aside className="hidden w-48 shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar/50 p-3 xl:flex">
          <QueueSidebar
            currentView={currentView}
            onViewChange={(view) => {
              setCurrentView(view);
              setSelectedId(null);
              setShowInspector(false);
            }}
            counts={counts}
            bots={bots}
            selectedBotId={selectedBotId}
            onBotChange={(botId) => {
              setSelectedBotId(botId);
              setSelectedId(null);
              setShowInspector(false);
            }}
          />
        </aside>

        {/* Conversation list */}
        <section
          className={`min-h-0 flex-1 flex-col border-b border-border bg-card md:flex-none md:w-64 md:border-b-0 md:border-r xl:w-[17rem] ${
            selectedId ? 'hidden md:flex' : 'flex'
          }`}
        >
          <div className="space-y-2 border-b border-border p-3">
            <div className="grid grid-cols-2 gap-2 xl:hidden">
              <label className="min-w-0">
                <span className="sr-only">Queue view</span>
                <select
                  value={currentView}
                  onChange={(event) => {
                    setCurrentView(event.target.value as QueueView);
                    setSelectedId(null);
                    setShowInspector(false);
                  }}
                  className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  {QUEUE_VIEWS.map((view) => (
                    <option key={view.value} value={view.value}>
                      {view.label} ({counts[view.value]})
                    </option>
                  ))}
                </select>
              </label>

              <label className="min-w-0">
                <span className="sr-only">Filter by bot</span>
                <select
                  value={selectedBotId ?? ''}
                  onChange={(event) => {
                    setSelectedBotId(event.target.value || undefined);
                    setSelectedId(null);
                    setShowInspector(false);
                  }}
                  className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs text-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="">All bots</option>
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground"
              />
              <Input
                aria-label="Search conversations"
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>

            <div className="px-1 text-xs text-muted-foreground">
              {filteredQueueItems.length} conversation
              {filteredQueueItems.length === 1 ? '' : 's'}
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {queueLoading && queueItems.length === 0 ? (
              <div className="flex justify-center py-12">
                <Spinner size="md" />
              </div>
            ) : filteredQueueItems.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <Inbox
                  aria-hidden="true"
                  className="mx-auto mb-2 h-7 w-7 text-muted-foreground"
                />
                <p className="text-xs font-medium text-foreground">No conversations found</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {currentView === 'unassigned'
                    ? 'Every escalated ticket has been claimed.'
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

        {/* Transcript, composer and inspector */}
        <main
          className={`relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background ${
            selectedId ? 'flex' : 'hidden md:flex'
          }`}
        >
          {selectedId && activeConversation ? (
            <>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                {detailLoading ? (
                  <div className="flex flex-1 items-center justify-center">
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
                      onBack={() => {
                        setSelectedId(null);
                        setShowInspector(false);
                      }}
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

              {showInspector && (
                <>
                  <button
                    type="button"
                    aria-label="Close conversation info"
                    onClick={() => setShowInspector(false)}
                    className="absolute inset-0 z-20 bg-overlay xl:hidden"
                  />
                  <div className="absolute inset-y-0 right-0 z-30 w-80 max-w-[85%] border-l border-border bg-card shadow-xl xl:static xl:z-auto xl:w-[13.5rem] xl:max-w-none xl:shadow-none">
                    <ContactPanel
                      conversation={activeConversation}
                      contact={activeConversation.contact}
                      onClose={() => setShowInspector(false)}
                    />
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
              <Inbox
                aria-hidden="true"
                className="mb-3 h-7 w-7 text-muted-foreground"
              />
              <h2 className="text-sm font-semibold text-foreground">Select a conversation</h2>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                Choose a ticket from the queue to read the transcript, claim it, or reply to the
                customer.
              </p>
            </div>
          )}
        </main>
      </div>

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
            void loadQueue();
          }}
        />
      )}
    </div>
  );
}
