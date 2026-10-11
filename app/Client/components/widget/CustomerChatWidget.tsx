'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  MessageSquare,
  X,
  Send,
  Bot,
  User,
  Headphones,
  Clock,
  CheckCircle2,
  AlertCircle,
  Minimize2,
  ChevronDown,
  RotateCcw,
  Sparkles,
  Wifi,
  WifiOff,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { io, Socket } from 'socket.io-client';

import {
  startPublicConversation,
  getPublicTranscript,
  sendPublicMessage,
  refreshVisitorToken,
  submitPublicContact,
  getStoredSession,
  setStoredSession,
  clearStoredSession,
  type PublicMessage,
  type PublicConversation,
  type StoredVisitorSession,
  PublicApiError,
} from '@/lib/api/publicChat';

interface CustomerChatWidgetProps {
  botId: string;
  botName?: string;
  defaultOpen?: boolean;
  standalone?: boolean;
  onClose?: () => void;
  className?: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1';
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || API_BASE.replace(/\/api\/v1\/?$/, '');

export function CustomerChatWidget({
  botId,
  botName = 'Support Assistant',
  defaultOpen = false,
  standalone = false,
  onClose,
  className = '',
}: CustomerChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen || standalone);
  const [initializing, setInitializing] = useState(false);
  const [conversation, setConversation] = useState<PublicConversation | null>(null);
  const [visitorToken, setVisitorToken] = useState<string | null>(null);
  const [sessionSecret, setSessionSecret] = useState<string | null>(null);
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [socketConnected, setSocketConnected] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Contact capture form
  const [showContactForm, setShowContactForm] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactSubmitting, setContactSubmitting] = useState(false);
  const [contactSaved, setContactSaved] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const convIdRef = useRef<string | null>(null);
  convIdRef.current = conversation?.id || null;

  // Auto-scroll to bottom on messages update
  useEffect(() => {
    if (isOpen) {
      bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
    }
  }, [messages.length, isTyping, isOpen]);

  // Focus input on open
  useEffect(() => {
    if (isOpen) {
      setUnreadCount(0);
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Initialize or resume conversation session
  const initSession = useCallback(async () => {
    if (!botId) return;
    setInitializing(true);
    setErrorBanner(null);

    const stored = getStoredSession(botId);

    if (stored && stored.conversationId && stored.sessionSecret) {
      try {
        let token = stored.visitorToken;

        // If we have no cached token, refresh right away using the secret
        if (!token) {
          const refreshRes = await refreshVisitorToken(
            stored.conversationId,
            '',
            stored.sessionSecret,
          );
          token = refreshRes.visitorToken;
        }

        try {
          const transcriptData = await getPublicTranscript(stored.conversationId, token);
          setConversation(transcriptData.conversation);
          setVisitorToken(token);
          setSessionSecret(stored.sessionSecret);
          setMessages(transcriptData.items || []);

          setStoredSession(botId, {
            ...stored,
            visitorToken: token,
          });
          setInitializing(false);
          return;
        } catch (fetchErr) {
          // If token expired (401), try to refresh token
          if (fetchErr instanceof PublicApiError && fetchErr.status === 401) {
            const refreshRes = await refreshVisitorToken(
              stored.conversationId,
              token,
              stored.sessionSecret,
            );
            const newToken = refreshRes.visitorToken;
            const transcriptData = await getPublicTranscript(
              stored.conversationId,
              newToken,
            );

            setConversation(transcriptData.conversation);
            setVisitorToken(newToken);
            setSessionSecret(stored.sessionSecret);
            setMessages(transcriptData.items || []);

            setStoredSession(botId, {
              ...stored,
              visitorToken: newToken,
            });
            setInitializing(false);
            return;
          }
          // Otherwise start fresh
          throw fetchErr;
        }
      } catch {
        // Session invalid or closed, start fresh
        clearStoredSession(botId);
      }
    }

    // Start fresh conversation
    try {
      const res = await startPublicConversation(botId);
      setConversation(res.conversation);
      setVisitorToken(res.visitorToken);
      setSessionSecret(res.sessionSecret);
      setMessages([]);

      setStoredSession(botId, {
        conversationId: res.conversation.id,
        sessionSecret: res.sessionSecret,
        visitorToken: res.visitorToken,
        botId,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      setErrorBanner(
        err instanceof PublicApiError ? err.message : 'Unable to start chat session.',
      );
    } finally {
      setInitializing(false);
    }
  }, [botId]);

  useEffect(() => {
    initSession();
  }, [initSession]);

  // Periodic token refresh (every 10 minutes)
  useEffect(() => {
    if (!conversation || !sessionSecret || !visitorToken) return;

    const interval = setInterval(async () => {
      try {
        const res = await refreshVisitorToken(
          conversation.id,
          visitorToken,
          sessionSecret,
        );
        setVisitorToken(res.visitorToken);
        setStoredSession(botId, {
          conversationId: conversation.id,
          sessionSecret,
          visitorToken: res.visitorToken,
          botId,
          createdAt: new Date().toISOString(),
        });
      } catch {
        // Refresh will be retried on next request if needed
      }
    }, 10 * 60 * 1000);

    return () => clearInterval(interval);
  }, [conversation, sessionSecret, visitorToken, botId]);

  // Connect to Socket.IO room `conversation:<id>` using visitorToken
  useEffect(() => {
    if (!conversation?.id || !visitorToken) return;

    const conversationId = conversation.id;
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      auth: { token: visitorToken },
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    function onConnect() {
      setSocketConnected(true);
      socket.emit(
        'room:join',
        { room: `conversation:${conversationId}` },
        () => {},
      );
    }

    function onDisconnect() {
      setSocketConnected(false);
    }

    function onMessageNew(msg: {
      id: string;
      conversationId: string;
      role: PublicMessage['role'];
      content: string;
      createdAt: string;
      clientMessageId?: string | null;
    }) {
      if (msg.conversationId !== convIdRef.current) return;

      setIsTyping(false);

      setMessages((prev) => {
        // Match optimistic message
        if (msg.clientMessageId) {
          const index = prev.findIndex((m) => m.clientMessageId === msg.clientMessageId);
          if (index !== -1) {
            const updated = [...prev];
            updated[index] = {
              ...updated[index],
              id: msg.id,
              createdAt: msg.createdAt,
            };
            return updated;
          }
        }

        // Avoid duplicate by id
        if (prev.some((m) => m.id === msg.id)) {
          return prev;
        }

        if (!isOpen) {
          setUnreadCount((count) => count + 1);
        }

        return [
          ...prev,
          {
            id: msg.id,
            role: msg.role,
            content: msg.content,
            createdAt: msg.createdAt,
            clientMessageId: msg.clientMessageId,
          },
        ];
      });
    }

    function onEscalated() {
      setConversation((prev) =>
        prev ? { ...prev, status: 'WAITING_FOR_HUMAN', escalatedAt: new Date().toISOString() } : null,
      );
    }

    function onClaimed() {
      setConversation((prev) =>
        prev ? { ...prev, status: 'HUMAN_ACTIVE' } : null,
      );
    }

    function onAssigned() {
      setConversation((prev) =>
        prev ? { ...prev, status: 'HUMAN_ACTIVE' } : null,
      );
    }

    function onResolved() {
      setConversation((prev) =>
        prev ? { ...prev, status: 'RESOLVED', resolvedAt: new Date().toISOString() } : null,
      );
    }

    function onReopened() {
      setConversation((prev) =>
        prev ? { ...prev, status: 'ACTIVE', resolvedAt: null } : null,
      );
    }

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('message:new', onMessageNew);
    socket.on('conversation:escalated', onEscalated);
    socket.on('conversation:claimed', onClaimed);
    socket.on('conversation:assigned', onAssigned);
    socket.on('conversation:resolved', onResolved);
    socket.on('conversation:reopened', onReopened);

    return () => {
      socket.emit('room:leave', { room: `conversation:${conversation.id}` });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [conversation?.id, visitorToken, isOpen]);

  // Send message
  async function handleSendMessage(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const text = inputText.trim();
    if (!text || sending || !conversation?.id || !visitorToken) return;

    setInputText('');
    setSending(true);
    setIsTyping(true);

    const clientMsgId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Optimistic user message
    const optimisticMsg: PublicMessage = {
      id: clientMsgId,
      role: 'USER',
      content: text,
      createdAt: new Date().toISOString(),
      clientMessageId: clientMsgId,
    };

    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const res = await sendPublicMessage(
        conversation.id,
        visitorToken,
        text,
        clientMsgId,
      );

      // Reconcile user message
      setMessages((prev) =>
        prev.map((m) =>
          m.clientMessageId === clientMsgId ? res.userMessage : m,
        ),
      );

      // If bot responded immediately
      setIsTyping(false);
      if (res.assistantMessage) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === res.assistantMessage?.id)) {
            return prev;
          }
          return [...prev, res.assistantMessage!];
        });
      }

      // If escalated
      if (res.escalation) {
        setConversation((prev) =>
          prev
            ? {
                ...prev,
                status: 'WAITING_FOR_HUMAN',
                escalatedAt: new Date().toISOString(),
              }
            : null,
        );
      }
    } catch (err) {
      setIsTyping(false);
      // Remove failed message
      setMessages((prev) => prev.filter((m) => m.clientMessageId !== clientMsgId));
      setErrorBanner(
        err instanceof PublicApiError ? err.message : 'Failed to send message. Please try again.',
      );
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  // Submit contact info
  async function handleContactSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!conversation?.id || !visitorToken) return;

    setContactSubmitting(true);
    try {
      await submitPublicContact(conversation.id, visitorToken, {
        name: contactName || undefined,
        email: contactEmail || undefined,
      });
      setContactSaved(true);
      setShowContactForm(false);
    } catch {
      // Ignore
    } finally {
      setContactSubmitting(false);
    }
  }

  const isWaiting = conversation?.status === 'WAITING_FOR_HUMAN';
  const isHumanActive = conversation?.status === 'HUMAN_ACTIVE';
  const isResolved = conversation?.status === 'RESOLVED';

  return (
    <div
      className={
        standalone
          ? 'w-full h-full flex flex-col bg-background'
          : `fixed bottom-5 right-5 z-50 flex flex-col items-end ${className}`
      }
    >
      {/* Floating launcher button when minimized */}
      {!standalone && !isOpen && (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-label="Open chat support"
          className="relative h-14 w-14 rounded-full bg-accent text-accent-foreground shadow-lg hover:shadow-xl hover:scale-105 transition-all duration-200 flex items-center justify-center cursor-pointer group"
        >
          <MessageSquare className="h-6 w-6 transition-transform group-hover:scale-110" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground text-[11px] font-bold flex items-center justify-center shadow-md animate-scale-in">
              {unreadCount}
            </span>
          )}
        </button>
      )}

      {/* Main chat window */}
      {(isOpen || standalone) && (
        <div
          className={
            standalone
              ? 'flex flex-col flex-1 w-full max-w-2xl mx-auto rounded-2xl border border-border bg-card shadow-sm overflow-hidden'
              : 'w-[92vw] sm:w-96 h-[550px] max-h-[85vh] rounded-2xl border border-border bg-card shadow-2xl flex flex-col overflow-hidden animate-scale-in'
          }
        >
          {/* Header */}
          <header className="px-4 py-3 bg-card border-b border-border flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="relative">
                <div className="h-8 w-8 rounded-full bg-accent/15 flex items-center justify-center">
                  <Bot className="h-4 w-4 text-accent" />
                </div>
                <span
                  className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card ${
                    socketConnected ? 'bg-success' : 'bg-muted-foreground'
                  }`}
                />
              </div>

              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground truncate">
                  {botName}
                </h3>
                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                  {socketConnected ? (
                    <>
                      <Wifi className="h-2.5 w-2.5 text-success" />
                      <span>Online</span>
                    </>
                  ) : (
                    <>
                      <WifiOff className="h-2.5 w-2.5 text-muted-foreground" />
                      <span>Connecting...</span>
                    </>
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {!standalone && (
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    onClose?.();
                  }}
                  aria-label="Minimize chat"
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                >
                  <Minimize2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </header>

          {/* Status Banners */}
          {errorBanner && (
            <div className="px-3.5 py-2 bg-destructive/10 border-b border-destructive/20 text-xs text-destructive flex items-center justify-between">
              <span>{errorBanner}</span>
              <button
                type="button"
                onClick={() => setErrorBanner(null)}
                className="p-1 hover:opacity-80"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {isWaiting && (
            <div className="px-3.5 py-2.5 bg-[var(--amber-50)] dark:bg-[color-mix(in_srgb,var(--amber-500)_15%,transparent)] border-b border-[var(--amber-500)]/30 text-xs text-[var(--amber-600)] dark:text-[var(--amber-400)] flex items-center gap-2">
              <Clock className="h-4 w-4 shrink-0 animate-pulse" />
              <div>
                <p className="font-semibold">Waiting for an available specialist...</p>
                <p className="text-[11px] opacity-90 mt-0.5">
                  Connecting you with a support specialist. We will reply here shortly.
                </p>
              </div>
            </div>
          )}

          {isHumanActive && (
            <div className="px-3.5 py-2 bg-accent/10 border-b border-accent/20 text-xs text-accent flex items-center gap-2">
              <Headphones className="h-4 w-4 shrink-0" />
              <span>Connected with a support specialist</span>
            </div>
          )}

          {isResolved && (
            <div className="px-3.5 py-2.5 bg-muted/60 border-b border-border text-xs text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
              <div>
                <p className="font-medium text-foreground">This conversation has been resolved.</p>
                <p className="text-[11px]">Need more help? Send a message to continue.</p>
              </div>
            </div>
          )}

          {/* Contact capture prompt if uncaptured */}
          {!contactSaved && !showContactForm && conversation && (
            <div className="px-3.5 py-1.5 bg-muted/30 border-b border-border flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Want email follow-up?</span>
              <button
                type="button"
                onClick={() => setShowContactForm(true)}
                className="text-accent font-medium hover:underline cursor-pointer"
              >
                Leave your details
              </button>
            </div>
          )}

          {showContactForm && (
            <form
              onSubmit={handleContactSubmit}
              className="p-3 bg-muted/40 border-b border-border space-y-2 text-xs"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-foreground">Contact Information</span>
                <button
                  type="button"
                  onClick={() => setShowContactForm(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              <input
                type="text"
                placeholder="Your name"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-lg border border-border bg-background text-foreground text-xs"
              />
              <input
                type="email"
                placeholder="Email address"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                required
                className="w-full px-2.5 py-1.5 rounded-lg border border-border bg-background text-foreground text-xs"
              />
              <button
                type="submit"
                disabled={contactSubmitting || !contactEmail}
                className="w-full py-1.5 rounded-lg bg-accent text-accent-foreground font-medium text-xs disabled:opacity-50 cursor-pointer"
              >
                {contactSubmitting ? 'Saving...' : 'Save Contact'}
              </button>
            </form>
          )}

          {/* Chat transcript thread */}
          <div className="flex-1 overflow-y-auto p-3.5 space-y-3 bg-background">
            {initializing ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-8">
                <div className="h-8 w-8 rounded-full border-2 border-accent border-t-transparent animate-spin mb-2" />
                <p className="text-xs text-muted-foreground">Starting conversation...</p>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-8 text-muted-foreground">
                <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center mb-2">
                  <Sparkles className="h-5 w-5 text-accent" />
                </div>
                <p className="text-xs font-semibold text-foreground">Hi there! How can we help?</p>
                <p className="text-[11px] text-muted-foreground mt-1 max-w-xs">
                  Ask any question and our AI assistant or support team will assist you.
                </p>
              </div>
            ) : (
              messages.map((m) => {
                const isUser = m.role === 'USER';
                const isAgent = m.role === 'AGENT';
                const isAssistant = m.role === 'ASSISTANT';

                return (
                  <div
                    key={m.id || m.clientMessageId}
                    className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} animate-fade-in`}
                  >
                    <div className="flex items-center gap-1.5 mb-0.5 px-1">
                      {isAgent && (
                        <div className="h-3.5 w-3.5 rounded-full bg-accent flex items-center justify-center">
                          <Headphones className="h-2 w-2 text-accent-foreground" />
                        </div>
                      )}
                      {isAssistant && (
                        <div className="h-3.5 w-3.5 rounded-full bg-muted flex items-center justify-center">
                          <Bot className="h-2 w-2 text-accent" />
                        </div>
                      )}
                      <span className="text-[10px] font-medium text-muted-foreground">
                        {isUser && 'You'}
                        {isAssistant && botName}
                        {isAgent && 'Support Specialist'}
                      </span>
                    </div>

                    <div
                      className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-xs transition-all ${
                        isUser
                          ? 'bg-accent text-accent-foreground rounded-tr-xs'
                          : isAgent
                          ? 'bg-card text-card-foreground border border-accent/40 shadow-xs rounded-tl-xs'
                          : 'bg-muted text-foreground rounded-tl-xs'
                      }`}
                    >
                      <div
                        className={`prose prose-xs max-w-none break-words ${
                          isUser ? 'prose-invert' : 'dark:prose-invert'
                        } [&>p:first-child]:mt-0 [&>p:last-child]:mb-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0`}
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                    </div>

                    {/* Sources citation disclosure */}
                    {isAssistant && m.sources && m.sources.length > 0 && (
                      <div className="mt-1 px-1">
                        <span className="text-[10px] text-muted-foreground/80">
                          Sources: {m.sources.map((s) => s.label || s.topic).join(', ')}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {isTyping && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-1 px-2 animate-fade-in">
                <Bot className="h-3.5 w-3.5 text-accent animate-pulse" />
                <span className="text-[11px] italic">Assistant is typing...</span>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Footer composer */}
          <form
            onSubmit={handleSendMessage}
            className="p-2.5 bg-card border-t border-border flex items-center gap-2 shrink-0"
          >
            <input
              ref={inputRef}
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder={isResolved ? 'Send a message to reopen...' : 'Type a message...'}
              disabled={initializing || sending}
              className="flex-1 px-3 py-2 rounded-xl border border-border bg-background text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:border-accent focus:ring-1 focus:ring-accent transition-all disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!inputText.trim() || sending || initializing}
              aria-label="Send message"
              className="h-8 w-8 rounded-xl bg-accent text-accent-foreground flex items-center justify-center transition-all disabled:opacity-40 hover:opacity-90 cursor-pointer shrink-0 shadow-xs"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
