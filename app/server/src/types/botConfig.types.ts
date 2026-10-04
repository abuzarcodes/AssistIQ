/**
 * Bot configuration types (docs/BOT_IMPLEMENTATION_PLAN.md §9, Appendix B).
 *
 * `ResolvedBotConfig` is the **complete** configuration the API returns: every field is
 * present, because `resolveBotConfig` merges a stored row over `botDefaults.ts`. That is
 * deliberate — a client never has to know a default, so the defaults cannot drift between
 * client and server.
 */

import type {
  AfterHoursBehavior,
  BotPersonality,
  BotTone,
  HumanRequestBehavior,
  KnowledgeStrictness,
  ResponseLength,
} from '@prisma/client';

/** Which generation parameters a catalog model can actually accept (§12). */
export interface ModelCapabilities {
  temperature: boolean;
  topP: boolean;
  maxTokens: boolean;
  frequencyPenalty: boolean;
  presencePenalty: boolean;
}

/** A generation parameter the UI can disable when the selected model cannot use it. */
export type GenerationParamName =
  | 'temperature'
  | 'topP'
  | 'maxTokens'
  | 'frequencyPenalty'
  | 'presencePenalty';

/** Days a business-hours window can fall on. */
export type DayCode = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

/** One open window. At most one per day in v1 (§14.3). */
export interface BusinessHoursWindow {
  day: DayCode;
  /** `HH:MM`, 24-hour. */
  start: string;
  /** `HH:MM`, 24-hour, exclusive. */
  end: string;
}

/** Human-support business hours (§14.3). */
export interface BusinessHours {
  /** IANA timezone name, e.g. "Europe/Berlin". */
  timezone: string;
  windows: BusinessHoursWindow[];
  afterHoursBehavior: AfterHoursBehavior;
  /** Shown to the customer when an escalation lands outside hours. */
  afterHoursMessage: string | null;
}

/** A contact field the owner can ask the customer for (§14.6). */
export type ContactField = 'name' | 'email' | 'phone' | 'orderId';

/** Contact-collection configuration (§14.6). */
export interface ContactCollection {
  enabled: boolean;
  fields: ContactField[];
  /** Must be a subset of `fields`; enforced by the invariants schema. */
  required: ContactField[];
}

/** The optional intro card shown before the first message. */
export interface ConversationStarter {
  headline: string;
  body: string;
  ctaLabel: string | null;
}

/** A knowledge source attached to an assistant message (§15.3). Identifiers only —
 *  never a score, never a chunk excerpt. Scores are the deferred Tier 3 diagnostics. */
export interface SourceRef {
  chunkId: string;
  sourceId: string | null;
  topic: string | null;
  pageNumber: number | null;
  /** Resolved by Node from its own `KnowledgeSource` rows, for display. */
  label?: string | null;
}

/**
 * The full, resolved configuration returned by the API. Grouped to match the dashboard's
 * sections and the wire contract in the plan's Appendix B.
 */
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

/**
 * The honest projection of stored intent against the resolved model's capabilities (§10.1).
 *
 * `ignoredParams` exists so the UI can grey out a control **without discarding the owner's
 * setting**: a value survives a temporary model swap and reactivates when a capable model
 * is selected again.
 */
export interface EffectiveInfo {
  appliedParams: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
  };
  ignoredParams: GenerationParamName[];
  /** The primary model is unusable and the fallback is serving instead (§13.2). */
  modelPromoted: boolean;
  /** Neither model is usable: chat will short-circuit without calling the AI service. */
  modelUnavailable: boolean;
  /** `knowledgeEnabled` **and** the bot actually has at least one enabled chunk. */
  knowledgeActive: boolean;
}

/** The shape `GET`/`PATCH` return. */
export interface BotConfigResponse {
  config: ResolvedBotConfig;
  effective: EffectiveInfo;
  version: number;
  updatedAt: string | null;
}

/** Escalation metadata returned alongside a sent message (§10.5). */
export interface EscalationInfo {
  required: boolean;
  offHours: boolean;
  /** Handoff or after-hours copy shown after the fallback line, when configured. */
  acceptanceMessage?: string;
}
