/**
 * The single source of truth for bot-configuration defaults
 * (docs/BOT_IMPLEMENTATION_PLAN.md §8).
 *
 * **Why here and not three places.** There is no shared constants package across TS, TSX
 * and Python, so a default table per layer would drift. This module is the Node authority:
 *
 *   - `resolveBotConfig` merges a stored row over these values, so **every API read returns
 *     a complete config** and the client needs no defaults of its own.
 *   - `botConfig.schema.ts` uses these same constants as its Zod `.default()` values, so a
 *     partial PATCH and a full read cannot disagree.
 *   - Python holds **no** mirror. An absent `config` on the AI request means *legacy
 *     behaviour* (the pre-feature pipeline), not "the defaults" — which is what makes the
 *     no-config regression test meaningful.
 *
 * The Prisma schema declares equivalent column defaults so a raw insert is safe. Those are
 * a database-level backstop; this object is what the application reads and returns.
 *
 * Every value below reproduces the behaviour of the code before this feature existed,
 * except `humanRequestBehavior`, which is called out explicitly (see the plan §8.2).
 */

import type {
  BotPersonality,
  BotTone,
  HumanRequestBehavior,
  KnowledgeStrictness,
  ResponseLength,
} from '@prisma/client';

/** Column-level defaults for a `BotConfiguration` row. */
export const BOT_CONFIG_DEFAULTS = {
  // Appearance
  displayName: null,

  // Personality & instructions
  personality: 'PROFESSIONAL' satisfies BotPersonality,
  tone: 'NEUTRAL' satisfies BotTone,
  customPersonality: null,
  customInstructions: null,
  responseLanguage: 'AUTO',
  responseLength: 'BALANCED' satisfies ResponseLength,

  // Conversation
  welcomeMessage: null,
  conversationStarter: null,
  suggestedQuestions: [] as string[],
  inputPlaceholder: null,
  thinkingMessages: [] as string[],
  feedbackEnabled: false,
  feedbackCollectReason: true,

  // Knowledge
  knowledgeEnabled: true,
  // BALANCED is *exactly* the pre-feature gate: "results must be non-empty", with no score
  // threshold. STRICT activates `is_confident`, which was dead code until now (§15.2).
  knowledgeStrictness: 'BALANCED' satisfies KnowledgeStrictness,
  showSources: false,
  retrievalTopK: 3, // mirrors the hard-coded `top_k=3` in chat_service.py:109

  // Generation
  temperature: 0.0, // mirrors the hard-coded `temperature=0.0` in chat_service.py:138
  topP: null, // null means "do not send the parameter at all"
  frequencyPenalty: null,
  presencePenalty: null,
  maxOutputTokens: null,

  // Human support
  humanFallbackEnabled: true, // every fallback escalated before this feature existed
  fallbackMessage: null, // null keeps the platform's per-reason copy
  /**
   * ⚠ The ONE intentional behaviour change in this feature. There is no human-request
   * detection today, so any value is new behaviour; "ignore an explicit request for a
   * human" is not a defensible default for a support product. See the plan §8.2.
   */
  humanRequestBehavior: 'TRANSFER_AUTOMATICALLY' satisfies HumanRequestBehavior,
  handoffMessage: null,
  businessHours: null, // inert until configured
  contactCollection: null, // inert until configured
} as const;

/** `responseLength` presets. BALANCED adds neither an instruction nor a token cap (§11.3). */
export const RESPONSE_LENGTH_PRESETS: Record<ResponseLength, { maxTokens: number | null; instruction: string | null }> = {
  SHORT: { maxTokens: 256, instruction: 'Keep answers short: one or two sentences unless the customer asks for more detail.' },
  BALANCED: { maxTokens: null, instruction: null },
  LONG: { maxTokens: 2048, instruction: 'Give thorough, detailed answers with any relevant steps or caveats.' },
};

/** Human-readable personality descriptions injected into the prompt (Block 3, §7.1). */
export const PERSONALITY_PROMPTS: Record<Exclude<BotPersonality, 'CUSTOM'>, string> = {
  PROFESSIONAL: 'Professional: clear, precise, businesslike. Avoid slang and exclamation marks.',
  FRIENDLY: 'Friendly: warm and approachable, using plain everyday language.',
  CONCISE: 'Concise: get to the point in as few words as possible. Never pad an answer.',
  WARM: 'Warm: kind and reassuring, acknowledging the customer’s situation before answering.',
  TECHNICAL: 'Technical: precise terminology and exact specifics. Assume an informed reader.',
  CASUAL: 'Casual: relaxed and conversational, like a helpful colleague.',
};

/** Tone fragments injected into the prompt (Block 3, §7.1). */
export const TONE_PROMPTS: Record<BotTone, string> = {
  NEUTRAL: 'Use a neutral, even tone.',
  FORMAL: 'Use formal language and complete sentences. Avoid contractions.',
  FRIENDLY: 'Keep the tone friendly and encouraging.',
  EMPATHETIC: 'Lead with empathy when the customer is frustrated or confused.',
  DIRECT: 'Be direct and unambiguous. State the answer first, then the detail.',
};

/**
 * Languages the owner can select. `AUTO` emits no instruction at all, which is what the
 * pipeline did before this feature — so it is the default.
 *
 * A fixed allow-list rather than free text: the value is interpolated into a prompt, and
 * an arbitrary string there is an injection surface for no product benefit.
 */
export const RESPONSE_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'AUTO', label: 'Match the customer’s language' },
  { code: 'en', label: 'English' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
];

export const RESPONSE_LANGUAGE_CODES: readonly string[] = RESPONSE_LANGUAGES.map((l) => l.code);

/**
 * The fallback reasons an owner may reword (§11.6).
 *
 * Platform-fault reasons (`MODEL_UNAVAILABLE`, `MODEL_RATE_LIMITED`, `MODEL_ERROR`) are
 * **never** in this set: they describe an outage on AssistIQ's side, and letting an owner
 * reword an outage into something reassuring would mislead their customers. The AI service
 * keeps returning its own copy for those, and Node passes it through untouched.
 */
export const CONVERSATIONAL_FALLBACK_REASONS: readonly string[] = [
  'NO_RELEVANT_KNOWLEDGE',
  'LOW_RETRIEVAL_CONFIDENCE',
  'LLM_INSUFFICIENT_INFORMATION',
  'LOW_CLASSIFICATION_CONFIDENCE',
];

/** Fixed feedback reason vocabulary, shared by the validator and the client (§10.6). */
export const FEEDBACK_REASONS = [
  'INACCURATE',
  'NOT_HELPFUL',
  'WRONG_SOURCE',
  'INCOMPLETE',
  'OTHER',
] as const;

export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

/** Contact fields an owner may request (§14.6). */
export const CONTACT_FIELDS = ['name', 'email', 'phone', 'orderId'] as const;

/** Field bounds. Exported so the Zod schema, the client and the tests share them. */
export const BOT_CONFIG_LIMITS = {
  displayName: 60,
  customPersonality: 500,
  customInstructions: 4000,
  welcomeMessage: 500,
  conversationStarterHeadline: 80,
  conversationStarterBody: 300,
  conversationStarterCtaLabel: 30,
  suggestedQuestions: { max: 6, item: 120 },
  thinkingMessages: { max: 5, item: 60 },
  inputPlaceholder: 120,
  fallbackMessage: 500,
  handoffMessage: 500,
  afterHoursMessage: 500,
  retrievalTopK: { min: 1, max: 20 },
  temperature: { min: 0, max: 2 },
  topP: { min: 0.01, max: 1 },
  penalty: { min: -2, max: 2 },
  maxOutputTokens: { min: 1, max: 8192 },
} as const;

/**
 * The sentinel the model emits when it cannot answer. An owner instruction containing this
 * string would make the pipeline's substring check fire on the *prompt* rather than on the
 * model's reply, so the validator rejects it outright (§7.3).
 */
export const INSUFFICIENT_INFORMATION_SIGNAL = 'INSUFFICIENT_INFORMATION';
