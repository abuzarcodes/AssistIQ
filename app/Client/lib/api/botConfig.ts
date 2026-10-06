import { apiGet, apiPatch, apiPost, apiPostFormData, apiDelete, apiGetBlob } from '@/lib/api-client';

/**
 * Bot configuration API (docs/BOT_IMPLEMENTATION_PLAN.md §10, Appendix B).
 *
 * The server returns a **complete** `ResolvedBotConfig` on every read — a bot with no stored
 * row resolves to the documented defaults — so this module defines no defaults of its own.
 * Where a value is `null`, the client keeps its presentational copy (an input placeholder,
 * a thinking message); that is presentation, not configuration.
 */

export type BotPersonality =
  | 'PROFESSIONAL'
  | 'FRIENDLY'
  | 'CONCISE'
  | 'WARM'
  | 'TECHNICAL'
  | 'CASUAL'
  | 'CUSTOM';

export type BotTone = 'NEUTRAL' | 'FORMAL' | 'FRIENDLY' | 'EMPATHETIC' | 'DIRECT';
export type ResponseLength = 'SHORT' | 'BALANCED' | 'LONG';
export type KnowledgeStrictness = 'STRICT' | 'BALANCED' | 'FLEXIBLE';
export type HumanRequestBehavior =
  | 'TRANSFER_AUTOMATICALLY'
  | 'UNAVAILABLE_MESSAGE'
  | 'CONTINUE_WITH_AI';
export type AfterHoursBehavior = 'MESSAGE_ONLY' | 'MESSAGE_AND_ESCALATE' | 'ESCALATE';
export type ContactField = 'name' | 'email' | 'phone' | 'orderId';

export interface BusinessHoursWindow {
  day: 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';
  start: string;
  end: string;
}

export interface BusinessHours {
  timezone: string;
  windows: BusinessHoursWindow[];
  afterHoursBehavior: AfterHoursBehavior;
  afterHoursMessage: string | null;
}

export interface ContactCollection {
  enabled: boolean;
  fields: ContactField[];
  required: ContactField[];
}

export interface ConversationStarter {
  headline: string;
  body: string;
  ctaLabel: string | null;
}

export interface ModelCapabilities {
  temperature: boolean;
  topP: boolean;
  maxTokens: boolean;
  frequencyPenalty: boolean;
  presencePenalty: boolean;
}

export type GenerationParamName =
  | 'temperature'
  | 'topP'
  | 'maxTokens'
  | 'frequencyPenalty'
  | 'presencePenalty';

export interface SourceRef {
  chunkId: string;
  sourceId: string | null;
  topic: string | null;
  pageNumber: number | null;
  label?: string | null;
}

export interface ResolvedBotConfig {
  general: {
    isActive: boolean;
    displayName: string | null;
    hasAvatar: boolean;
    avatarVersion: number;
  };
  personality: {
    preset: BotPersonality;
    tone: BotTone;
    customPersonality: string | null;
    customInstructions: string | null;
    responseLanguage: string;
    responseLength: ResponseLength;
  };
  conversation: {
    welcomeMessage: string | null;
    conversationStarter: ConversationStarter | null;
    suggestedQuestions: string[];
    inputPlaceholder: string | null;
    thinkingMessages: string[];
    feedbackEnabled: boolean;
    feedbackCollectReason: boolean;
  };
  knowledge: {
    enabled: boolean;
    strictness: KnowledgeStrictness;
    showSources: boolean;
    topK: number;
  };
  generation: {
    temperature: number;
    topP: number | null;
    frequencyPenalty: number | null;
    presencePenalty: number | null;
    maxOutputTokens: number | null;
  };
  model: {
    aiModelId: string | null;
    fallbackAiModelId: string | null;
  };
  humanSupport: {
    fallbackEnabled: boolean;
    fallbackMessage: string | null;
    humanRequestBehavior: HumanRequestBehavior;
    handoffMessage: string | null;
    businessHours: BusinessHours | null;
    contactCollection: ContactCollection | null;
  };
}

export interface EffectiveInfo {
  appliedParams: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
  };
  ignoredParams: GenerationParamName[];
  modelPromoted: boolean;
  modelUnavailable: boolean;
  knowledgeActive: boolean;
}

export interface BotConfigResponse {
  config: ResolvedBotConfig;
  effective: EffectiveInfo;
  version: number;
  updatedAt: string | null;
}

export interface EscalationInfo {
  required: boolean;
  offHours: boolean;
  acceptanceMessage?: string;
}

export interface AvatarState {
  avatarUrl: string;
  avatarUpdatedAt: string;
  avatarVersion: number;
}

/**
 * The flat patch the server accepts: any subset of the stored columns, plus the required
 * concurrency token. `expectedVersion` is mandatory — the server rejects a save that does
 * not say which version it edited (409 on mismatch).
 */
export type BotConfigPatch = Partial<{
  displayName: string | null;
  personality: BotPersonality;
  tone: BotTone;
  customPersonality: string | null;
  customInstructions: string | null;
  responseLanguage: string;
  responseLength: ResponseLength;
  welcomeMessage: string | null;
  conversationStarter: ConversationStarter | null;
  suggestedQuestions: string[];
  inputPlaceholder: string | null;
  thinkingMessages: string[];
  feedbackEnabled: boolean;
  feedbackCollectReason: boolean;
  knowledgeEnabled: boolean;
  knowledgeStrictness: KnowledgeStrictness;
  showSources: boolean;
  retrievalTopK: number;
  temperature: number;
  topP: number | null;
  frequencyPenalty: number | null;
  presencePenalty: number | null;
  maxOutputTokens: number | null;
  humanFallbackEnabled: boolean;
  fallbackMessage: string | null;
  humanRequestBehavior: HumanRequestBehavior;
  handoffMessage: string | null;
  businessHours: BusinessHours | null;
  contactCollection: ContactCollection | null;
}> & { expectedVersion: number };

export type ConfigSection =
  | 'general'
  | 'personality'
  | 'conversation'
  | 'knowledge'
  | 'humanSupport'
  | 'generation'
  | 'appearance'
  | 'all';

export function getBotConfig(botId: string) {
  return apiGet<BotConfigResponse>(`/bots/${botId}/config`);
}

export function updateBotConfig(botId: string, patch: BotConfigPatch) {
  return apiPatch<BotConfigResponse>(`/bots/${botId}/config`, patch);
}

export function resetBotConfig(
  botId: string,
  input: { section: ConfigSection; expectedVersion: number; includeAvatar?: boolean },
) {
  return apiPost<BotConfigResponse>(`/bots/${botId}/config/reset`, input);
}

export function uploadBotAvatar(botId: string, file: File) {
  const formData = new FormData();
  formData.append('avatar', file);
  return apiPostFormData<AvatarState>(`/bots/${botId}/avatar`, formData);
}

export function deleteBotAvatar(botId: string) {
  return apiDelete<AvatarState>(`/bots/${botId}/avatar`);
}

/** Fetch the avatar bytes as a blob; the caller renders them via an object URL. */
export function getBotAvatarBlob(botId: string) {
  return apiGetBlob(`/bots/${botId}/avatar`);
}

export interface PreviewResponse {
  response: string;
  fallback_required: boolean;
  reason?: string;
  sources?: SourceRef[] | null;
  appliedParams: EffectiveInfo['appliedParams'];
  ignoredParams: GenerationParamName[];
}

/** Test the unsaved draft without persisting anything (Checkpoint 7). */
export function previewBotConfig(botId: string, message: string, draft: ResolvedBotConfig) {
  return apiPost<PreviewResponse>(`/bots/${botId}/config/preview`, { message, draft });
}