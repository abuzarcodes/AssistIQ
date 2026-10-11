import { apiPost, apiGet, apiDelete } from '@/lib/api-client';
import type { EscalationInfo, SourceRef } from '@/lib/api/botConfig';

export type { EscalationInfo, SourceRef };

export type FeedbackRating = 'UP' | 'DOWN';
export type FeedbackReason = 'INACCURATE' | 'NOT_HELPFUL' | 'WRONG_SOURCE' | 'INCOMPLETE' | 'OTHER';

export interface MessageFeedback {
  rating: FeedbackRating;
  reason: string | null;
  comment: string | null;
}

export type MessageRole = 'USER' | 'ASSISTANT' | 'SYSTEM' | 'AGENT';

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  clientMessageId?: string | null;
  senderId?: string | null;
  /** Citation identifiers, present only when the bot shows sources (Checkpoint 5). */
  sources?: SourceRef[] | null;
  feedback?: MessageFeedback | null;
}

export interface ConversationContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  orderId: string | null;
}

export interface Conversation {
  id: string;
  botId: string;
  workspaceId?: string;
  status: string;
  assignedAgentId: string | null;
  escalatedAt?: string | null;
  escalationReason?: string | null;
  escalatedOffHours?: boolean | null;
  resolvedAt?: string | null;
  version?: number;
  createdAt: string;
  updatedAt: string;
  bot?: { id: string; name: string } | null;
  assignedAgent?: { id: string; name: string; email?: string } | null;
  messages?: Message[];
  contact?: ConversationContact | null;
}

export type QueueView = 'unassigned' | 'assigned' | 'all_active' | 'resolved';

export interface QueueItem {
  id: string;
  botId: string;
  workspaceId: string;
  status: 'ACTIVE' | 'WAITING_FOR_HUMAN' | 'HUMAN_ACTIVE' | 'RESOLVED';
  assignedAgentId: string | null;
  escalatedAt: string | null;
  escalationReason: string | null;
  escalatedOffHours: boolean | null;
  resolvedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  bot?: { id: string; name: string } | null;
  assignedAgent?: { id: string; name: string } | null;
  messages?: { role: MessageRole; content: string; createdAt: string }[];
}

export interface QueueResult {
  items: QueueItem[];
  pagination: { limit: number; hasMore: boolean };
}

export interface QueueFilterOptions {
  view?: QueueView;
  botId?: string;
  limit?: number;
}

export type ConversationEventType =
  | 'ESCALATED'
  | 'CLAIMED'
  | 'ASSIGNED'
  | 'REASSIGNED'
  | 'UNASSIGNED'
  | 'AGENT_REPLIED'
  | 'RESOLVED'
  | 'REOPENED';

export interface ConversationEvent {
  id: string;
  conversationId: string;
  actorId: string | null;
  eventType: ConversationEventType;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  actor?: { id: string; name: string; email: string } | null;
}

export interface AiMetadata {
  status: string;
  response: string;
  fallback_required: boolean;
  intent?: {
    predicted: string;
    confidence: number;
  };
  retrieval?: {
    used_topic_filter: boolean;
    top_score: number;
    documents_found: number;
  };
  reason?: string;
  /** Node-only fields; present on the wire but never rendered. */
  model_used?: string;
  failover_used?: boolean;
  human_requested?: boolean;
}

export interface SendMessageResponse {
  userMessage: Message;
  assistantMessage: Message | null;
  ai?: AiMetadata | null;
  sources?: SourceRef[];
  escalation?: EscalationInfo;
  suppressed?: boolean;
  suppressionReason?: 'AI_BYPASSED' | 'ABORTED' | 'STALE' | null;
}

export function listConversations(botId: string) {
  return apiGet<Conversation[]>(`/bots/${botId}/conversations`);
}

export function getConversation(conversationId: string) {
  return apiGet<Conversation>(`/conversations/${conversationId}`);
}

export function createConversation(botId: string) {
  return apiPost<Conversation>(`/bots/${botId}/conversations`);
}

export function sendMessage(conversationId: string, content: string) {
  return apiPost<SendMessageResponse>(`/conversations/${conversationId}/messages`, { content });
}

/** Rate an assistant message. Re-rating updates the existing row rather than duplicating. */
export function submitFeedback(
  conversationId: string,
  messageId: string,
  data: { rating: FeedbackRating; reason?: FeedbackReason | null; comment?: string | null },
) {
  return apiPost<MessageFeedback>(
    `/conversations/${conversationId}/messages/${messageId}/feedback`,
    data,
  );
}

export function deleteFeedback(conversationId: string, messageId: string) {
  return apiDelete<null>(`/conversations/${conversationId}/messages/${messageId}/feedback`);
}

/** Record the contact details a customer supplied for a conversation. */
export function submitContact(
  conversationId: string,
  data: Partial<ConversationContact>,
) {
  return apiPost<ConversationContact>(`/conversations/${conversationId}/contact`, data);
}

/** Fetch support queue conversations for a workspace. */
export function fetchQueue(workspaceId: string, options: QueueFilterOptions = {}) {
  const params = new URLSearchParams();
  if (options.view) params.set('view', options.view);
  if (options.botId) params.set('botId', options.botId);
  if (options.limit != null) params.set('limit', String(options.limit));

  const qs = params.toString();
  return apiGet<QueueResult>(`/workspaces/${workspaceId}/conversations/queue${qs ? `?${qs}` : ''}`);
}

/** Claim an unassigned conversation from the queue. */
export function claimConversation(conversationId: string) {
  return apiPost<Conversation>(`/conversations/${conversationId}/claim`);
}

/** Assign a conversation to an agent (requires OWNER or ADMIN). */
export function assignConversation(conversationId: string, agentId: string) {
  return apiPost<Conversation>(`/conversations/${conversationId}/assign`, { agentId });
}

/** Return an active conversation to the queue (unassign). */
export function unassignConversation(conversationId: string) {
  return apiPost<Conversation>(`/conversations/${conversationId}/unassign`);
}

/** Resolve a conversation. */
export function resolveConversation(conversationId: string) {
  return apiPost<Conversation>(`/conversations/${conversationId}/resolve`);
}

/** Reopen a resolved conversation. */
export function reopenConversation(conversationId: string) {
  return apiPost<Conversation>(`/conversations/${conversationId}/reopen`);
}

/** Send an agent reply to a customer. */
export function sendAgentReply(conversationId: string, content: string) {
  return apiPost<{ message: Message }>(`/conversations/${conversationId}/reply`, { content });
}

/** List audit trail events for a conversation. */
export async function listConversationEvents(conversationId: string): Promise<ConversationEvent[]> {
  const res = await apiGet<{ items: ConversationEvent[] } | ConversationEvent[]>(
    `/conversations/${conversationId}/events`,
  );
  if (Array.isArray(res)) return res;
  return res?.items || [];
}

/** Recover missed messages after a cursor. */
export function recoverMessages(
  conversationId: string,
  params: { afterCreatedAt?: string; afterId?: string; limit?: number } = {},
) {
  const query = new URLSearchParams();
  if (params.afterCreatedAt) query.set('afterCreatedAt', params.afterCreatedAt);
  if (params.afterId) query.set('afterId', params.afterId);
  if (params.limit != null) query.set('limit', String(params.limit));

  const qs = query.toString();
  return apiGet<{ items: Message[]; nextCursor: { afterCreatedAt: string; afterId: string } | null }>(
    `/conversations/${conversationId}/messages${qs ? `?${qs}` : ''}`,
  );
}