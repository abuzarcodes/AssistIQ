import type { MessageRole, SourceRef, EscalationInfo } from './conversations';
import type { ExperienceConfigSnapshot } from './experience';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1';

export interface PublicMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  clientMessageId?: string | null;
  sources?: SourceRef[] | null;
}

export interface PublicConversation {
  id: string;
  botId: string;
  status: 'ACTIVE' | 'WAITING_FOR_HUMAN' | 'HUMAN_ACTIVE' | 'RESOLVED';
  escalatedAt?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
}

export interface PublicTranscript {
  conversation: PublicConversation;
  items: PublicMessage[];
  nextCursor?: {
    afterCreatedAt: string;
    afterId: string;
  } | null;
}

export interface SendPublicMessageResponse {
  userMessage: PublicMessage;
  assistantMessage: PublicMessage | null;
  suppressed: boolean;
  suppressionReason?: 'AI_BYPASSED' | 'ABORTED' | 'STALE';
  escalation?: EscalationInfo;
}

export interface StoredVisitorSession {
  conversationId: string;
  sessionSecret: string;
  visitorToken?: string;
  botId: string;
  createdAt: string;
}

export class PublicApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'PublicApiError';
  }
}

async function publicFetch<T>(
  endpoint: string,
  options: RequestInit = {},
  visitorToken?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (visitorToken) {
    headers['Authorization'] = `Bearer ${visitorToken}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (res.status === 204) {
    return {} as T;
  }

  let body: { success?: boolean; data?: T; message?: string; error?: string };
  try {
    body = await res.json();
  } catch {
    throw new PublicApiError('Failed to parse response', res.status);
  }

  if (!res.ok || body.success === false) {
    throw new PublicApiError(
      body.error || body.message || `Request failed with status ${res.status}`,
      res.status,
      body,
    );
  }

  return body.data as T;
}

/** Storage key for sessionSecret in localStorage (§10.3). */
const getStorageKey = (botId: string) => `assistiq_session_${botId}`;

/** Retrieve stored visitor session for a bot. */
export function getStoredSession(botId: string): StoredVisitorSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(getStorageKey(botId));
    if (!raw) return null;
    return JSON.parse(raw) as StoredVisitorSession;
  } catch {
    return null;
  }
}

/** Store visitor session for a bot in localStorage. */
export function setStoredSession(botId: string, session: StoredVisitorSession): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(getStorageKey(botId), JSON.stringify(session));
  } catch {
    // Ignore storage quota errors
  }
}

/** Clear stored visitor session. */
export function clearStoredSession(botId: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(getStorageKey(botId));
  } catch {
    // Ignore
  }
}

/** POST /api/v1/public/bots/:botId/conversations — start a conversation (§10.3). */
export function startPublicConversation(botId: string) {
  return publicFetch<{
    conversation: PublicConversation;
    visitorToken: string;
    sessionSecret: string;
  }>(`/public/bots/${botId}/conversations`, { method: 'POST' });
}

/** GET /api/v1/public/conversations/:conversationId — get metadata + transcript (§14). */
export function getPublicTranscript(conversationId: string, visitorToken: string) {
  return publicFetch<PublicTranscript>(
    `/public/conversations/${conversationId}`,
    { method: 'GET' },
    visitorToken,
  );
}

/** POST /api/v1/public/conversations/:conversationId/messages — send customer message (§9.3, §14). */
export function sendPublicMessage(
  conversationId: string,
  visitorToken: string,
  content: string,
  clientMessageId?: string,
) {
  return publicFetch<SendPublicMessageResponse>(
    `/public/conversations/${conversationId}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ content, clientMessageId }),
    },
    visitorToken,
  );
}

/** POST /api/v1/public/conversations/:conversationId/refresh — renew visitor token (§10.3). */
export function refreshVisitorToken(
  conversationId: string,
  expiredToken: string,
  sessionSecret: string,
) {
  return publicFetch<{ visitorToken: string }>(
    `/public/conversations/${conversationId}/refresh`,
    {
      method: 'POST',
      body: JSON.stringify({ sessionSecret }),
    },
    expiredToken,
  );
}

/** POST /api/v1/public/conversations/:conversationId/contact — submit contact details (§14). */
export function submitPublicContact(
  conversationId: string,
  visitorToken: string,
  contact: { name?: string; email?: string; phone?: string; orderId?: string },
) {
  return publicFetch<{
    name: string | null;
    email: string | null;
    phone: string | null;
    orderId: string | null;
  }>(
    `/public/conversations/${conversationId}/contact`,
    {
      method: 'POST',
      body: JSON.stringify(contact),
    },
    visitorToken,
  );
}

/** GET /api/v1/public/conversations/:conversationId/messages — recover missed messages (§15.3.4). */
export function recoverPublicMessages(
  conversationId: string,
  visitorToken: string,
  params: { afterCreatedAt: string; afterId: string; limit?: number },
) {
  const query = new URLSearchParams({
    afterCreatedAt: params.afterCreatedAt,
    afterId: params.afterId,
  });
  if (params.limit != null) query.set('limit', String(params.limit));

  return publicFetch<{
    items: PublicMessage[];
    nextCursor: { afterCreatedAt: string; afterId: string } | null;
  }>(
    `/public/conversations/${conversationId}/messages?${query.toString()}`,
    { method: 'GET' },
    visitorToken,
  );
}

/**
 * The published deployment payload (Phase 11).
 *
 * Everything a public chat needs and nothing it must not have: the deployment's
 * identity, the bot's public name, and the published experience snapshot. Fields
 * the business left empty stay null — the chat fills them with its own defaults,
 * exactly like the studio's fallback display.
 */
export interface PublishedDeploymentPayload {
  deployment: {
    id: string;
    botId: string;
    workspaceId: string;
    format: 'HOSTED_PAGE' | 'WIDGET' | 'IFRAME';
    status: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
    slug: string | null;
    publishEpoch: number;
    allowedDomains: string[];
  };
  bot: {
    id: string;
    name: string;
  };
  config: ExperienceConfigSnapshot;
}

export type DeploymentClientEventType = 'page_view' | 'chat_start';

/** GET /api/v1/public/deployments/slug/:slug/config — hosted page entry point. */
export function getPublishedConfigBySlug(slug: string) {
  return publicFetch<PublishedDeploymentPayload>(
    `/public/deployments/slug/${encodeURIComponent(slug)}/config`,
    { method: 'GET' },
  );
}

/** GET /api/v1/public/deployments/:deploymentId/config — embed entry point. */
export function getPublishedConfigByDeploymentId(deploymentId: string) {
  return publicFetch<PublishedDeploymentPayload>(
    `/public/deployments/${encodeURIComponent(deploymentId)}/config`,
    { method: 'GET' },
  );
}

/**
 * POST /api/v1/public/deployments/:deploymentId/events — client analytics event.
 *
 * Fire-and-forget from the chat's perspective: the caller catches every failure
 * so a blocked analytics request can never break the conversation.
 */
export function recordDeploymentEvent(
  deploymentId: string,
  event: {
    eventType: DeploymentClientEventType;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  return publicFetch<{ recorded: boolean }>(
    `/public/deployments/${encodeURIComponent(deploymentId)}/events`,
    { method: 'POST', body: JSON.stringify(event) },
  );
}
