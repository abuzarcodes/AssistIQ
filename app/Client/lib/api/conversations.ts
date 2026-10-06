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

export interface Message {
  id: string;
  conversationId: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  content: string;
  createdAt: string;
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
  status: string;
  assignedAgentId: string | null;
  escalatedAt?: string | null;
  escalationReason?: string | null;
  escalatedOffHours?: boolean | null;
  createdAt: string;
  updatedAt: string;
  messages?: Message[];
  contact?: ConversationContact | null;
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
  assistantMessage: Message;
  ai: AiMetadata;
  sources?: SourceRef[];
  escalation?: EscalationInfo;
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