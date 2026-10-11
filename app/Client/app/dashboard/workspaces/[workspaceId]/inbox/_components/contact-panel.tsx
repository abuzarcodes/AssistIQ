'use client';

import { useState, useEffect } from 'react';
import { User, Mail, Phone, ShoppingBag, Clock, History, ChevronDown, ChevronRight, Shield } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { listConversationEvents, type Conversation, type ConversationContact, type ConversationEvent } from '@/lib/api/conversations';

interface ContactPanelProps {
  conversation: Conversation;
  contact?: ConversationContact | null;
}

export function ContactPanel({ conversation, contact }: ContactPanelProps) {
  const [eventsOpen, setEventsOpen] = useState(false);
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  useEffect(() => {
    if (eventsOpen && conversation.id) {
      loadEvents();
    }
  }, [eventsOpen, conversation.id]);

  async function loadEvents() {
    setEventsLoading(true);
    try {
      const data = await listConversationEvents(conversation.id);
      setEvents(Array.isArray(data) ? data : (data as { items?: ConversationEvent[] })?.items || []);
    } catch {
      // Best-effort
    } finally {
      setEventsLoading(false);
    }
  }

  return (
    <div className="w-72 border-l border-border bg-card p-4 flex flex-col h-full overflow-y-auto space-y-5 animate-fade-in">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
          <User className="h-3.5 w-3.5" />
          Customer Information
        </h3>

        {contact && (contact.name || contact.email || contact.phone || contact.orderId) ? (
          <div className="space-y-2.5 bg-muted/30 p-3 rounded-xl border border-border">
            {contact.name && (
              <div className="flex items-start gap-2">
                <User className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">Name</p>
                  <p className="text-xs font-medium text-foreground truncate">{contact.name}</p>
                </div>
              </div>
            )}
            {contact.email && (
              <div className="flex items-start gap-2">
                <Mail className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">Email</p>
                  <a
                    href={`mailto:${contact.email}`}
                    className="text-xs font-medium text-accent hover:underline truncate block"
                  >
                    {contact.email}
                  </a>
                </div>
              </div>
            )}
            {contact.phone && (
              <div className="flex items-start gap-2">
                <Phone className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">Phone</p>
                  <p className="text-xs font-medium text-foreground">{contact.phone}</p>
                </div>
              </div>
            )}
            {contact.orderId && (
              <div className="flex items-start gap-2">
                <ShoppingBag className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[11px] text-muted-foreground">Order ID</p>
                  <p className="text-xs font-mono font-medium text-foreground">{contact.orderId}</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="p-3 rounded-xl border border-dashed border-border bg-muted/20 text-center">
            <p className="text-xs text-muted-foreground">No customer contact captured yet.</p>
          </div>
        )}
      </div>

      <div className="space-y-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5" />
          Ticket Metadata
        </h3>

        <div className="space-y-2 text-xs">
          <div className="flex justify-between items-center py-1 border-b border-border/60">
            <span className="text-muted-foreground">Status</span>
            <Badge variant={conversation.status === 'WAITING_FOR_HUMAN' ? 'warning' : conversation.status === 'HUMAN_ACTIVE' ? 'info' : conversation.status === 'RESOLVED' ? 'success' : 'default'}>
              {conversation.status}
            </Badge>
          </div>

          {conversation.bot && (
            <div className="flex justify-between items-center py-1 border-b border-border/60">
              <span className="text-muted-foreground">Bot</span>
              <span className="font-medium text-foreground">{conversation.bot.name}</span>
            </div>
          )}

          {conversation.escalationReason && (
            <div className="flex justify-between items-center py-1 border-b border-border/60">
              <span className="text-muted-foreground">Escalation</span>
              <span className="font-mono text-[11px] text-foreground bg-muted px-1.5 py-0.5 rounded">
                {conversation.escalationReason}
              </span>
            </div>
          )}

          {conversation.escalatedAt && (
            <div className="flex justify-between items-center py-1 border-b border-border/60">
              <span className="text-muted-foreground">Escalated</span>
              <span className="text-[11px] text-muted-foreground">
                {new Date(conversation.escalatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          )}

          <div className="flex justify-between items-center py-1 border-b border-border/60">
            <span className="text-muted-foreground">Created</span>
            <span className="text-[11px] text-muted-foreground">
              {new Date(conversation.createdAt).toLocaleDateString()}
            </span>
          </div>

          <div className="flex justify-between items-center py-1">
            <span className="text-muted-foreground">Ticket ID</span>
            <span className="font-mono text-[10px] text-muted-foreground truncate max-w-[120px]">
              {conversation.id}
            </span>
          </div>
        </div>
      </div>

      <div className="pt-2 border-t border-border">
        <button
          type="button"
          onClick={() => setEventsOpen((prev) => !prev)}
          className="w-full flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
        >
          <span className="flex items-center gap-1.5">
            <History className="h-3.5 w-3.5" />
            Audit History
          </span>
          {eventsOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        {eventsOpen && (
          <div className="mt-3 space-y-2">
            {eventsLoading ? (
              <div className="flex justify-center py-4">
                <Spinner size="sm" />
              </div>
            ) : !Array.isArray(events) || events.length === 0 ? (
              <p className="text-[11px] text-muted-foreground text-center py-2">No events recorded.</p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {(Array.isArray(events) ? events : []).map((event) => (
                  <div
                    key={event.id}
                    className="p-2 rounded-lg bg-muted/40 border border-border text-[11px] space-y-0.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-foreground">{event.eventType}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(event.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    {event.actor && (
                      <p className="text-[10px] text-muted-foreground">
                        By {event.actor.name}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
