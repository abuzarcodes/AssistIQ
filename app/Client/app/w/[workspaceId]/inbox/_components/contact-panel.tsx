'use client';

import { useState, useEffect } from 'react';
import {
  User,
  Mail,
  Phone,
  ShoppingBag,
  History,
  ChevronDown,
  ChevronRight,
  Shield,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  listConversationEvents,
  type Conversation,
  type ConversationContact,
  type ConversationEvent,
} from '@/lib/api/conversations';

function BreakableEmail({ email }: { email: string }) {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  return (
    <>
      {local}@<wbr />
      {domain}
    </>
  );
}

interface ContactPanelProps {
  conversation: Conversation;
  contact?: ConversationContact | null;
  onClose?: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Bot active',
  WAITING_FOR_HUMAN: 'Waiting for human',
  HUMAN_ACTIVE: 'Human active',
  RESOLVED: 'Resolved',
};

function formatEventType(value: string) {
  const clean = value.replace(/[._]/g, ' ').toLowerCase();
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function ContactPanel({ conversation, contact, onClose }: ContactPanelProps) {
  const [eventsOpen, setEventsOpen] = useState(false);
  const [events, setEvents] = useState<ConversationEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  useEffect(() => {
    if (!eventsOpen || !conversation.id) return;

    let cancelled = false;

    async function loadEvents() {
      setEventsLoading(true);
      try {
        const data = await listConversationEvents(conversation.id);
        if (!cancelled) {
          setEvents(
            Array.isArray(data)
              ? data
              : (data as { items?: ConversationEvent[] })?.items || [],
          );
        }
      } catch {
        // Best-effort: the transcript and ticket actions remain usable.
      } finally {
        if (!cancelled) setEventsLoading(false);
      }
    }

    void loadEvents();

    return () => {
      cancelled = true;
    };
  }, [eventsOpen, conversation.id]);

  const hasContact = Boolean(
    contact && (contact.name || contact.email || contact.phone || contact.orderId),
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-foreground">
          Conversation info
        </h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close conversation info"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 xl:hidden"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
      </div>

      <section className="space-y-3 border-b border-border pb-5">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <User aria-hidden="true" className="h-3.5 w-3.5" />
          Customer
        </h3>

        {hasContact ? (
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            {contact?.name && (
              <div className="flex items-start gap-2">
                <User aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Name</p>
                  <p className="truncate text-[13px] font-medium text-foreground">
                    {contact.name}
                  </p>
                </div>
              </div>
            )}
            {contact?.email && (
              <div className="flex items-start gap-2">
                <Mail aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Email</p>
                  <a
                    href={`mailto:${contact.email}`}
                    title={contact.email}
                    className="block break-words text-[13px] font-medium text-accent-strong hover:underline"
                  >
                    <BreakableEmail email={contact.email} />
                  </a>
                </div>
              </div>
            )}
            {contact?.phone && (
              <div className="flex items-start gap-2">
                <Phone aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Phone</p>
                  <p className="text-[13px] font-medium text-foreground">{contact.phone}</p>
                </div>
              </div>
            )}
            {contact?.orderId && (
              <div className="flex items-start gap-2">
                <ShoppingBag aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Order ID</p>
                  <p className="font-mono text-[13px] font-medium text-foreground">
                    {contact.orderId}
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3 text-center">
            <p className="text-xs text-muted-foreground">No contact details captured.</p>
          </div>
        )}
      </section>

      <section className="space-y-3 border-b border-border py-5">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Shield aria-hidden="true" className="h-3.5 w-3.5" />
          Ticket
        </h3>

        <dl className="space-y-2.5 text-xs">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <Badge
                variant={
                  conversation.status === 'WAITING_FOR_HUMAN'
                    ? 'warning'
                    : conversation.status === 'HUMAN_ACTIVE'
                      ? 'info'
                      : conversation.status === 'RESOLVED'
                        ? 'success'
                        : 'default'
                }
              >
                {STATUS_LABELS[conversation.status] ?? conversation.status}
              </Badge>
            </dd>
          </div>

          {conversation.bot && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Bot</dt>
              <dd className="truncate font-medium text-foreground">{conversation.bot.name}</dd>
            </div>
          )}

          {conversation.escalationReason && (
            <div className="flex items-start justify-between gap-3">
              <dt className="shrink-0 text-muted-foreground">Escalation</dt>
              <dd className="truncate text-right font-mono text-xs text-foreground">
                {conversation.escalationReason}
              </dd>
            </div>
          )}

          {conversation.escalatedAt && (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Escalated</dt>
              <dd className="text-xs text-muted-foreground">
                {new Date(conversation.escalatedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </dd>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Created</dt>
            <dd className="text-xs text-muted-foreground">
              {new Date(conversation.createdAt).toLocaleDateString()}
            </dd>
          </div>

          <div className="flex items-start justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">Ticket ID</dt>
            <dd
              className="max-w-[7.5rem] truncate font-mono text-xs text-muted-foreground"
              title={conversation.id}
            >
              {conversation.id}
            </dd>
          </div>
        </dl>
      </section>

      <section className="pt-4">
        <button
          type="button"
          onClick={() => setEventsOpen((prev) => !prev)}
          aria-expanded={eventsOpen}
          className="flex w-full cursor-pointer items-center justify-between text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <span className="flex items-center gap-1.5">
            <History aria-hidden="true" className="h-3.5 w-3.5" />
            Audit history
          </span>
          {eventsOpen ? (
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </button>

        {eventsOpen && (
          <div className="mt-3 space-y-2">
            {eventsLoading ? (
              <div className="flex justify-center py-4">
                <Spinner size="sm" />
              </div>
            ) : !Array.isArray(events) || events.length === 0 ? (
              <p className="py-2 text-center text-xs text-muted-foreground">
                No events recorded.
              </p>
            ) : (
              <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                {(Array.isArray(events) ? events : []).map((event) => (
                  <div
                    key={event.id}
                    className="space-y-0.5 rounded-lg border border-border bg-muted/40 p-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">
                        {formatEventType(event.eventType)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(event.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    {event.actor && (
                      <p className="text-xs text-muted-foreground">By {event.actor.name}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
