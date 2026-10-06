'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, MessageSquare, Plus, Send, AlertTriangle } from 'lucide-react';
import { getBot, type Bot } from '@/lib/api/bots';
import {
  listConversations,
  getConversation,
  createConversation,
  sendMessage,
  submitFeedback,
  submitContact,
  type Conversation,
  type ConversationContact,
  type Message,
  type MessageFeedback,
  type EscalationInfo,
} from '@/lib/api/conversations';
import { getBotConfig, type ResolvedBotConfig, type ContactField } from '@/lib/api/botConfig';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { ChatMessage } from '../_components/chat-message';

/**
 * The conversations panel, now driven by the bot's resolved configuration (plan §16.5).
 *
 * The page already fetched the bot; it now fetches the config in parallel and renders the
 * welcome message, starter, suggested-question chips, placeholder, rotating thinking
 * messages, sources, feedback controls and the contact form — all of which are inert on a
 * bot still on the recommended defaults.
 */
export default function ConversationsPage() {
  const params = useParams<{ botId: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const [bot, setBot] = useState<Bot | null>(null);
  const [config, setConfig] = useState<ResolvedBotConfig | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [convStatus, setConvStatus] = useState<string>('');
  const [escalation, setEscalation] = useState<EscalationInfo | null>(null);
  const [contact, setContact] = useState<ConversationContact | null>(null);
  const [feedback, setFeedback] = useState<Record<string, MessageFeedback>>({});

  const [loading, setLoading] = useState(true);
  const [loadingConv, setLoadingConv] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState('');
  const [thinkingIndex, setThinkingIndex] = useState(0);
  const [contactForm, setContactForm] = useState<Record<string, string>>({});
  const [savingContact, setSavingContact] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadInitialData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.botId]);

  useEffect(() => {
    if (activeConvId) {
      loadConversation(activeConvId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId]);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, sending]);

  // Rotate the configured thinking messages while a reply is generating.
  const thinkingMessages = config?.conversation.thinkingMessages ?? [];
  useEffect(() => {
    if (!sending || thinkingMessages.length <= 1) return;
    const timer = setInterval(() => {
      setThinkingIndex((i) => (i + 1) % thinkingMessages.length);
    }, 2500);
    return () => clearInterval(timer);
  }, [sending, thinkingMessages.length]);

  async function loadInitialData() {
    try {
      const [b, convs, cfg] = await Promise.all([
        getBot(params.botId),
        listConversations(params.botId),
        getBotConfig(params.botId),
      ]);
      setBot(b);
      setConfig(cfg.config);
      setConversations(convs);
      if (convs.length > 0) {
        setActiveConvId(convs[0].id);
      }
    } catch {
      toast('Failed to load conversations', 'error');
      router.push(`/dashboard/bots/${params.botId}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadConversation(id: string) {
    setLoadingConv(true);
    try {
      const data = await getConversation(id);
      setMessages(data.messages || []);
      setConvStatus(data.status);
      setContact(data.contact ?? null);
      const map: Record<string, MessageFeedback> = {};
      for (const message of data.messages ?? []) {
        if (message.feedback) map[message.id] = message.feedback;
      }
      setFeedback(map);
    } catch {
      toast('Failed to load conversation details', 'error');
    } finally {
      setLoadingConv(false);
    }
  }

  async function handleNewConversation() {
    setCreating(true);
    try {
      const newConv = await createConversation(params.botId);
      setConversations((prev) => [newConv, ...prev]);
      setActiveConvId(newConv.id);
      setEscalation(null);
    } catch {
      toast('Failed to start conversation', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || !activeConvId) return;

    const content = input.trim();
    setInput('');
    setSending(true);

    const tempId = `temp-${Date.now()}`;
    const optimisticMessage: Message = {
      id: tempId,
      conversationId: activeConvId,
      role: 'USER',
      content,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      const res = await sendMessage(activeConvId, content);

      const assistant: Message = {
        ...res.assistantMessage,
        sources: res.assistantMessage.sources ?? res.sources ?? null,
      };

      setMessages((prev) => [
        ...prev.filter((m) => m.id !== tempId),
        res.userMessage,
        assistant,
      ]);

      if (res.ai.fallback_required || res.escalation?.required) {
        setConvStatus('WAITING_FOR_HUMAN');
      }
      if (res.escalation) {
        setEscalation(res.escalation);
      }

      setConversations((prev) =>
        prev
          .map((c) =>
            c.id === activeConvId ? { ...c, updatedAt: new Date().toISOString() } : c,
          )
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to send message', 'error');
      setInput(content);
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
    } finally {
      setSending(false);
    }
  }

  async function rate(messageId: string, rating: 'UP' | 'DOWN') {
    if (!activeConvId) return;
    try {
      const result = await submitFeedback(activeConvId, messageId, { rating });
      setFeedback((prev) => ({ ...prev, [messageId]: result }));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to record feedback', 'error');
    }
  }

  async function handleContactSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!activeConvId) return;
    setSavingContact(true);
    try {
      const result = await submitContact(activeConvId, contactForm);
      setContact(result);
      toast('Contact details saved', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save contact details', 'error');
    } finally {
      setSavingContact(false);
    }
  }

  const contactFields = useMemo<ContactField[]>(
    () => config?.humanSupport.contactCollection?.fields ?? [],
    [config],
  );

  if (loading || !bot) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  const showContactForm =
    config?.humanSupport.contactCollection?.enabled === true &&
    convStatus === 'WAITING_FOR_HUMAN' &&
    !contact;

  return (
    <div className="animate-fade-in flex flex-col h-[calc(100vh-8rem)]">
      <div className="mb-4 shrink-0">
        <button
          onClick={() => router.push(`/dashboard/bots/${bot.id}`)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Bot
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* Sidebar: Conversation List */}
        <div className="w-64 md:w-80 border-r border-border flex flex-col bg-sidebar shrink-0">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <h2 className="font-semibold text-foreground text-sm">Conversations</h2>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0 rounded-full"
              onClick={handleNewConversation}
              disabled={creating}
            >
              {creating ? <Spinner size="sm" /> : <Plus className="h-4 w-4" />}
            </Button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 ? (
              <div className="p-4 text-center">
                <p className="text-xs text-muted-foreground">No conversations yet.</p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-3 w-full"
                  onClick={handleNewConversation}
                >
                  Start Chat
                </Button>
              </div>
            ) : (
              <div className="flex flex-col">
                {conversations.map((conv) => (
                  <button
                    key={conv.id}
                    onClick={() => setActiveConvId(conv.id)}
                    className={`text-left p-3 border-b border-border transition-colors cursor-pointer ${
                      activeConvId === conv.id ? 'bg-sidebar-active' : 'hover:bg-muted'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-foreground truncate">
                        {new Date(conv.createdAt).toLocaleString()}
                      </span>
                      {conv.status === 'WAITING_FOR_HUMAN' && (
                        <span
                          className="w-2 h-2 rounded-full bg-destructive flex-shrink-0"
                          title="Waiting for human"
                        />
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground block truncate">
                      ID: {conv.id.substring(0, 8)}...
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Main: Chat Area */}
        <div className="flex-1 flex flex-col bg-background min-w-0">
          {!activeConvId ? (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState
                icon={MessageSquare}
                title="Select a conversation"
                description="Choose an existing conversation from the list or start a new one."
              />
            </div>
          ) : (
            <>
              <div className="h-14 border-b border-border px-4 flex items-center justify-between shrink-0 bg-card">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">Chat Interface</span>
                  {convStatus === 'WAITING_FOR_HUMAN' && (
                    <Badge variant="danger" dot>WAITING FOR HUMAN</Badge>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {loadingConv ? (
                  <div className="flex justify-center py-8">
                    <Spinner size="md" />
                  </div>
                ) : (
                  <>
                    {messages.length === 0 && !sending && (
                      <div className="flex flex-col items-center gap-3 py-8 text-center">
                        {config?.conversation.conversationStarter ? (
                          <div className="max-w-sm rounded-xl border border-border bg-card p-4">
                            <p className="text-sm font-semibold text-foreground">
                              {config.conversation.conversationStarter.headline}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {config.conversation.conversationStarter.body}
                            </p>
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            {config?.conversation.welcomeMessage ?? 'Start by sending a message.'}
                          </p>
                        )}
                        {(config?.conversation.suggestedQuestions.length ?? 0) > 0 && (
                          <div className="flex flex-wrap justify-center gap-1.5">
                            {config!.conversation.suggestedQuestions.map((question) => (
                              <button
                                key={question}
                                type="button"
                                onClick={() => setInput(question)}
                                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                              >
                                {question}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {messages.map((msg) => (
                      <ChatMessage
                        key={msg.id}
                        role={msg.role}
                        content={msg.content}
                        sources={msg.sources}
                        feedbackEnabled={config?.conversation.feedbackEnabled ?? false}
                        feedback={feedback[msg.id]}
                        onFeedback={(rating) => rate(msg.id, rating)}
                      />
                    ))}

                    {convStatus === 'WAITING_FOR_HUMAN' && !sending && (
                      <div className="flex justify-center my-4">
                        <div className="bg-[var(--amber-50)] dark:bg-[color-mix(in_srgb,var(--amber-500)_15%,transparent)] border border-[var(--amber-500)]/20 rounded-lg px-4 py-3 max-w-md flex items-start gap-3 text-[var(--amber-600)] dark:text-[var(--amber-500)]">
                          <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-sm font-semibold mb-1">Human Fallback Triggered</p>
                            <p className="text-xs">
                              {escalation?.acceptanceMessage ??
                                'The AI Assistant could not confidently answer the last question. This conversation has been escalated for human assistance.'}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {showContactForm && (
                      <form
                        onSubmit={handleContactSubmit}
                        className="mx-auto w-full max-w-sm space-y-3 rounded-xl border border-border bg-card p-4"
                      >
                        <p className="text-sm font-medium text-foreground">
                          How can the team reach you?
                        </p>
                        {contactFields.map((field) => (
                          <Input
                            key={field}
                            id={`contact-${field}`}
                            label={field === 'orderId' ? 'Order ID' : field.charAt(0).toUpperCase() + field.slice(1)}
                            type={field === 'email' ? 'email' : 'text'}
                            value={contactForm[field] ?? ''}
                            onChange={(e) =>
                              setContactForm((prev) => ({ ...prev, [field]: e.target.value }))
                            }
                          />
                        ))}
                        <Button type="submit" size="sm" loading={savingContact}>
                          Send details
                        </Button>
                      </form>
                    )}

                    {sending && (
                      <div className="flex justify-start">
                        <div className="max-w-[80%] rounded-2xl rounded-tl-sm bg-muted text-foreground px-4 py-3 flex items-center gap-2">
                          <Spinner size="sm" />
                          <span className="text-xs text-muted-foreground animate-pulse">
                            {thinkingMessages[thinkingIndex] ?? 'AI is thinking...'}
                          </span>
                        </div>
                      </div>
                    )}
                  </>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="p-4 bg-card border-t border-border shrink-0">
                <form onSubmit={handleSend} className="flex gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={
                      convStatus === 'WAITING_FOR_HUMAN'
                        ? 'Waiting for human agent to reply...'
                        : config?.conversation.inputPlaceholder ?? 'Type a message...'
                    }
                    disabled={sending || convStatus === 'WAITING_FOR_HUMAN'}
                    className="flex-1 h-10 rounded-full border border-border bg-background px-4 text-sm focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <Button
                    type="submit"
                    disabled={!input.trim() || sending || convStatus === 'WAITING_FOR_HUMAN'}
                    className="rounded-full h-10 w-10 p-0 shrink-0"
                  >
                    <Send className="h-4 w-4 ml-0.5" />
                  </Button>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}