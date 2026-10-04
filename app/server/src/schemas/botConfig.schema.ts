import { z } from 'zod';
import {
  AfterHoursBehavior,
  BotPersonality,
  BotTone,
  HumanRequestBehavior,
  KnowledgeStrictness,
  ResponseLength,
} from '@prisma/client';
import {
  BOT_CONFIG_LIMITS as L,
  CONTACT_FIELDS,
  FEEDBACK_REASONS,
  INSUFFICIENT_INFORMATION_SIGNAL,
  RESPONSE_LANGUAGE_CODES,
} from '../constants/botDefaults.js';

/**
 * Validation for the bot-configuration endpoints
 * (docs/BOT_IMPLEMENTATION_PLAN.md §19).
 *
 * Two layers, mirroring `platformSettings.schema.ts` exactly:
 *
 *  1. `updateBotConfigSchema` bounds each field independently, rejects an empty body, and
 *     requires `expectedVersion`. It cannot check the cross-field rules — a patch supplying
 *     only `personality` has nothing to compare against until it is merged with the row.
 *  2. `resolvedBotConfigSchema` declares the same fields as **required** and refines them
 *     against each other. The service parses the *merged* candidate through it before
 *     writing, so the invariants hold for every write regardless of which subset arrived.
 *
 * The bounds are also the client's copy: `BOT_CONFIG_LIMITS` is exported from
 * `constants/botDefaults.ts` so the character counters and the server agree by construction.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real IANA timezone, checked against the runtime's own tz database. */
const isRealTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const uniqueStrings = (values: string[]): boolean =>
  new Set(values.map((v) => v.trim().toLowerCase())).size === values.length;

/**
 * Owner instructions.
 *
 * The sentinel check is a hard rejection, not a warning. `ChatService` detects an
 * unanswerable question by substring-matching `INSUFFICIENT_INFORMATION` in the model's
 * reply; an owner instruction containing that literal would be interpolated into the
 * *prompt*, and while the current check only inspects the reply, allowing the token in the
 * prompt is a latent false-positive and an obvious injection foothold. Rejecting it keeps
 * the sentinel meaningful (§7.3).
 */
const customInstructionsSchema = z
  .string()
  .trim()
  .max(L.customInstructions)
  .refine((value) => !value.toUpperCase().includes(INSUFFICIENT_INFORMATION_SIGNAL), {
    message:
      'Instructions cannot contain the reserved word INSUFFICIENT_INFORMATION — it is used internally to detect unanswered questions.',
  });

const conversationStarterSchema = z.object({
  headline: z.string().trim().min(1).max(L.conversationStarterHeadline),
  body: z.string().trim().min(1).max(L.conversationStarterBody),
  ctaLabel: z.string().trim().max(L.conversationStarterCtaLabel).nullable().optional(),
});

const businessHoursSchema = z
  .object({
    timezone: z.string().trim().min(1).max(64).refine(isRealTimezone, {
      message: 'Unknown timezone',
    }),
    windows: z
      .array(
        z
          .object({
            day: z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']),
            start: z.string().regex(HHMM, 'Start time must be HH:MM (24-hour)'),
            end: z.string().regex(HHMM, 'End time must be HH:MM (24-hour)'),
          })
          .refine((w) => w.start < w.end, {
            message: 'A window must start before it ends',
            path: ['end'],
          })
      )
      .min(1, 'Add at least one open window')
      .max(7)
      .refine((windows) => new Set(windows.map((w) => w.day)).size === windows.length, {
        message: 'Only one window per day is supported',
      }),
    afterHoursBehavior: z.nativeEnum(AfterHoursBehavior),
    afterHoursMessage: z.string().trim().max(L.afterHoursMessage).nullable(),
  })
  .refine((h) => !h.afterHoursMessage || h.afterHoursMessage.length > 0, {
    message: 'After-hours message cannot be blank',
  });

const contactCollectionSchema = z
  .object({
    enabled: z.boolean(),
    fields: z.array(z.enum(CONTACT_FIELDS)).max(CONTACT_FIELDS.length),
    required: z.array(z.enum(CONTACT_FIELDS)).max(CONTACT_FIELDS.length),
  })
  .refine((c) => new Set(c.fields).size === c.fields.length, {
    message: 'Contact fields cannot repeat',
    path: ['fields'],
  })
  .refine((c) => c.required.every((field) => c.fields.includes(field)), {
    message: 'A required field must also be a collected field',
    path: ['required'],
  });

/**
 * Every configurable field, at full strength. `updateBotConfigSchema` is this object
 * `.partial()`; `resolvedBotConfigSchema` is it with the relational rules attached.
 *
 * Model assignment is deliberately **absent**: `aiModelId` / `fallbackAiModelId` are changed
 * through `PATCH /bots/:botId/model`, which saves immediately. Keeping them out means a
 * config PATCH never conflicts with a model change — they touch disjoint columns (§22).
 */
const configFields = {
  // --- Appearance / general ---
  displayName: z.string().trim().max(L.displayName).nullable(),

  // --- Personality & instructions ---
  personality: z.nativeEnum(BotPersonality),
  tone: z.nativeEnum(BotTone),
  customPersonality: z.string().trim().max(L.customPersonality).nullable(),
  customInstructions: customInstructionsSchema.nullable(),
  responseLanguage: z
    .string()
    .trim()
    .refine((code) => RESPONSE_LANGUAGE_CODES.includes(code), { message: 'Unsupported language' }),
  responseLength: z.nativeEnum(ResponseLength),

  // --- Conversation ---
  welcomeMessage: z.string().trim().max(L.welcomeMessage).nullable(),
  conversationStarter: conversationStarterSchema.nullable(),
  suggestedQuestions: z
    .array(z.string().trim().min(1).max(L.suggestedQuestions.item))
    .max(L.suggestedQuestions.max, `At most ${L.suggestedQuestions.max} suggested questions`)
    .refine(uniqueStrings, { message: 'Suggested questions must be unique' }),
  inputPlaceholder: z.string().trim().max(L.inputPlaceholder).nullable(),
  thinkingMessages: z
    .array(z.string().trim().min(1).max(L.thinkingMessages.item))
    .max(L.thinkingMessages.max, `At most ${L.thinkingMessages.max} thinking messages`)
    .refine(uniqueStrings, { message: 'Thinking messages must be unique' }),
  feedbackEnabled: z.boolean(),
  feedbackCollectReason: z.boolean(),

  // --- Knowledge ---
  knowledgeEnabled: z.boolean(),
  knowledgeStrictness: z.nativeEnum(KnowledgeStrictness),
  showSources: z.boolean(),
  retrievalTopK: z.number().int().min(L.retrievalTopK.min).max(L.retrievalTopK.max),

  // --- Generation ---
  temperature: z.number().min(L.temperature.min).max(L.temperature.max),
  topP: z.number().gt(0).max(L.topP.max).nullable(),
  frequencyPenalty: z.number().min(L.penalty.min).max(L.penalty.max).nullable(),
  presencePenalty: z.number().min(L.penalty.min).max(L.penalty.max).nullable(),
  maxOutputTokens: z
    .number()
    .int()
    .min(L.maxOutputTokens.min)
    .max(L.maxOutputTokens.max)
    .nullable(),

  // --- Human support ---
  humanFallbackEnabled: z.boolean(),
  fallbackMessage: z.string().trim().max(L.fallbackMessage).nullable(),
  humanRequestBehavior: z.nativeEnum(HumanRequestBehavior),
  handoffMessage: z.string().trim().max(L.handoffMessage).nullable(),
  businessHours: businessHoursSchema.nullable(),
  contactCollection: contactCollectionSchema.nullable(),
} as const;

const configObject = z.object(configFields);

/**
 * The PATCH body: any subset of the fields above, plus the concurrency token.
 *
 * `expectedVersion` is required rather than optional. A last-write-wins configuration save
 * would let two tabs silently clobber each other, and an owner losing typed instructions is
 * the worst outcome this feature can produce (§16.2). A caller that genuinely does not care
 * about concurrency can send the version it just read; what it cannot do is fail to say.
 */
export const updateBotConfigSchema = configObject
  .partial()
  .extend({ expectedVersion: z.number().int().min(0) })
  .refine(
    (data) =>
      Object.entries(data).some(([key, value]) => key !== 'expectedVersion' && value !== undefined),
    { message: 'Provide at least one field to update' }
  );

/**
 * The relational rules, checked on the fully-merged candidate (§19.2).
 *
 * Each rejects a configuration that is internally contradictory, and names the field at
 * fault so the owner can see what to change.
 */
export const resolvedBotConfigSchema = configObject
  .refine((c) => c.personality !== 'CUSTOM' || (c.customPersonality?.trim().length ?? 0) > 0, {
    message: 'Describe the custom personality, or choose a preset',
    path: ['customPersonality'],
  })
  .refine((c) => c.knowledgeEnabled || !c.showSources, {
    message: 'Sources cannot be shown when knowledge is disabled',
    path: ['showSources'],
  });

/** Body for `POST /bots/:botId/config/reset`. */
export const resetBotConfigSchema = z.object({
  section: z
    .enum([
      'general',
      'personality',
      'conversation',
      'knowledge',
      'humanSupport',
      'generation',
      'appearance',
      'all',
    ])
    .default('all'),
  includeAvatar: z.boolean().default(false),
  expectedVersion: z.number().int().min(0),
});

/**
 * The grouped wire shape (Appendix B), used to validate a preview draft.
 *
 * This is distinct from `resolvedBotConfigSchema`: that validates the *merged columns*
 * internally (flat, keyed by column name), while the API and the client speak the grouped
 * shape. The preview is the one endpoint that accepts a whole config from the client, so it
 * needs the grouped schema rather than the internal one.
 */
export const resolvedConfigWireSchema = z.object({
  general: z.object({
    isActive: z.boolean(),
    displayName: z.string().trim().max(L.displayName).nullable(),
    hasAvatar: z.boolean(),
    avatarVersion: z.number().int().min(0),
  }),
  personality: z.object({
    preset: z.nativeEnum(BotPersonality),
    tone: z.nativeEnum(BotTone),
    customPersonality: z.string().trim().max(L.customPersonality).nullable(),
    customInstructions: customInstructionsSchema.nullable(),
    responseLanguage: z
      .string()
      .trim()
      .refine((code) => RESPONSE_LANGUAGE_CODES.includes(code), { message: 'Unsupported language' }),
    responseLength: z.nativeEnum(ResponseLength),
  }),
  conversation: z.object({
    welcomeMessage: z.string().trim().max(L.welcomeMessage).nullable(),
    conversationStarter: conversationStarterSchema.nullable(),
    suggestedQuestions: z
      .array(z.string().trim().min(1).max(L.suggestedQuestions.item))
      .max(L.suggestedQuestions.max),
    inputPlaceholder: z.string().trim().max(L.inputPlaceholder).nullable(),
    thinkingMessages: z
      .array(z.string().trim().min(1).max(L.thinkingMessages.item))
      .max(L.thinkingMessages.max),
    feedbackEnabled: z.boolean(),
    feedbackCollectReason: z.boolean(),
  }),
  knowledge: z.object({
    enabled: z.boolean(),
    strictness: z.nativeEnum(KnowledgeStrictness),
    showSources: z.boolean(),
    topK: z.number().int().min(L.retrievalTopK.min).max(L.retrievalTopK.max),
  }),
  generation: z.object({
    temperature: z.number().min(L.temperature.min).max(L.temperature.max),
    topP: z.number().gt(0).max(L.topP.max).nullable(),
    frequencyPenalty: z.number().min(L.penalty.min).max(L.penalty.max).nullable(),
    presencePenalty: z.number().min(L.penalty.min).max(L.penalty.max).nullable(),
    maxOutputTokens: z
      .number()
      .int()
      .min(L.maxOutputTokens.min)
      .max(L.maxOutputTokens.max)
      .nullable(),
  }),
  model: z.object({
    aiModelId: z.string().uuid().nullable(),
    fallbackAiModelId: z.string().uuid().nullable(),
  }),
  humanSupport: z.object({
    fallbackEnabled: z.boolean(),
    fallbackMessage: z.string().trim().max(L.fallbackMessage).nullable(),
    humanRequestBehavior: z.nativeEnum(HumanRequestBehavior),
    handoffMessage: z.string().trim().max(L.handoffMessage).nullable(),
    businessHours: businessHoursSchema.nullable(),
    contactCollection: contactCollectionSchema.nullable(),
  }),
});

/** Body for `POST /bots/:botId/config/preview` (§17.2). */
export const previewConfigSchema = z.object({
  message: z.string().trim().min(1, 'Enter a message to test').max(4000),
  /**
   * The unsaved draft. Validated with the **full grouped** schema, not a partial one:
   * accepting a partial draft would silently preview defaults instead of the owner's edits.
   */
  draft: resolvedConfigWireSchema,
});

/** Body for the feedback endpoints (§10.6). */
export const messageFeedbackSchema = z.object({
  rating: z.enum(['UP', 'DOWN']),
  /** Must be from the fixed vocabulary — an arbitrary string would make the aggregate
   *  useless and is an obvious place for a client to smuggle free text. */
  reason: z.enum(FEEDBACK_REASONS).nullable().optional(),
  comment: z.string().trim().max(1000).nullable().optional(),
});

/** Body for `POST /conversations/:conversationId/contact` (§10.7). */
export const conversationContactSchema = z.object({
  name: z.string().trim().min(1).max(120).nullable().optional(),
  email: z.string().trim().email('Enter a valid email address').max(254).nullable().optional(),
  phone: z.string().trim().min(3).max(40).nullable().optional(),
  orderId: z.string().trim().min(1).max(120).nullable().optional(),
});

export type UpdateBotConfigInput = z.infer<typeof updateBotConfigSchema>;
export type ResolvedBotConfigInput = z.infer<typeof resolvedBotConfigSchema>;
export type ResetBotConfigInput = z.infer<typeof resetBotConfigSchema>;
export type PreviewConfigInput = z.infer<typeof previewConfigSchema>;
export type MessageFeedbackInput = z.infer<typeof messageFeedbackSchema>;
export type ConversationContactInput = z.infer<typeof conversationContactSchema>;
