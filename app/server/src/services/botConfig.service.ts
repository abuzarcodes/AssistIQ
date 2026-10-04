import { Prisma } from '@prisma/client';
import type {
  BotConfiguration,
  BotPersonality,
  BotTone,
  HumanRequestBehavior,
  KnowledgeStrictness,
  ResponseLength,
} from '@prisma/client';
import prisma from '../config/database.js';
import { AppError, NotFoundError } from '../utils/errors.js';
import { getBotById } from './bot.service.js';
import { resolveBotModel } from './botModelResolver.js';
import { aiServiceClient } from './aiServiceClient.js';
import { resolveSourceLabels } from './sourceLabels.js';
import { MODEL_UNAVAILABLE_MESSAGE } from '../constants/aiFailure.js';
import { logger } from '../config/logger.js';
import {
  BOT_CONFIG_DEFAULTS,
  RESPONSE_LENGTH_PRESETS,
} from '../constants/botDefaults.js';
import { resolveCapabilities } from '../constants/modelCapabilities.js';
import {
  resolvedBotConfigSchema,
  type PreviewConfigInput,
  type ResetBotConfigInput,
  type ResolvedBotConfigInput,
  type UpdateBotConfigInput,
} from '../schemas/botConfig.schema.js';
import type {
  BotConfigResponse,
  BusinessHours,
  ContactCollection,
  ConversationStarter,
  EffectiveInfo,
  GenerationParamName,
  ModelCapabilities,
  ResolvedBotConfig,
  SourceRef,
} from '../types/botConfig.types.js';

/**
 * Bot configuration: resolution, validation and persistence
 * (docs/BOT_IMPLEMENTATION_PLAN.md §8, §9, §10.1, §22).
 *
 * The central property: **a bot with no `BotConfiguration` row resolves to the documented
 * defaults**, so no backfill was needed, "reset to recommended" is a delete-shaped write,
 * and every API read returns a complete configuration the client can render without
 * knowing a single default of its own.
 *
 * **No cache, by design** — mirroring `botModelResolver`. A configuration change therefore
 * takes effect on the next message with no invalidation path to get wrong. The opposite
 * trade from `PlatformSetting` (global, rarely written) is correct here (per-bot, written
 * interactively).
 */

/**
 * The configurable columns, typed with their **domain** types rather than Prisma's
 * `JsonValue`.
 *
 * Declared explicitly instead of derived from `BotConfiguration`: Prisma types every `Json`
 * column as the `JsonValue` union, and the conversion to and from the domain shapes has to
 * happen somewhere. Putting the domain types here means that conversion happens exactly
 * once, in `readJson`/`writeJson`, instead of at every use site.
 */
interface ConfigColumns {
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
}

/** The nullable `Json` columns, which accept `DbNull` on write. */
const NULLABLE_JSON_COLUMNS = new Set<keyof ConfigColumns>([
  'conversationStarter',
  'businessHours',
  'contactCollection',
]);

/**
 * Read a `Json` column as its domain type.
 *
 * Prisma types every `Json` column as the `JsonValue` union, which no concrete interface is
 * assignable to or from. The cast is confined to this one function, and the Zod schema
 * validated the value on the way in, so the shape is known rather than assumed.
 */
const readJson = <T>(value: Prisma.JsonValue | null): T | null =>
  (value ?? null) as unknown as T | null;

/**
 * Convert a domain value for a nullable `Json` column.
 *
 * `Prisma.DbNull` — not JS `null` — is what writes SQL NULL. `Prisma.JsonNull` would write a
 * JSON literal `null`, a different value that `readJson` would read back as present-but-null.
 */
const writeJson = (value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);



/**
 * A plain, typed copy of the column defaults.
 *
 * Spread into a fresh object each call: `BOT_CONFIG_DEFAULTS` is `as const` and shared, and
 * handing the same array (e.g. `suggestedQuestions`) to two callers would let one mutate
 * the other's view of the defaults.
 */
const columnDefaults = (): ConfigColumns => ({
  displayName: BOT_CONFIG_DEFAULTS.displayName,
  personality: BOT_CONFIG_DEFAULTS.personality,
  tone: BOT_CONFIG_DEFAULTS.tone,
  customPersonality: BOT_CONFIG_DEFAULTS.customPersonality,
  customInstructions: BOT_CONFIG_DEFAULTS.customInstructions,
  responseLanguage: BOT_CONFIG_DEFAULTS.responseLanguage,
  responseLength: BOT_CONFIG_DEFAULTS.responseLength,
  welcomeMessage: BOT_CONFIG_DEFAULTS.welcomeMessage,
  conversationStarter: BOT_CONFIG_DEFAULTS.conversationStarter,
  suggestedQuestions: [...BOT_CONFIG_DEFAULTS.suggestedQuestions],
  inputPlaceholder: BOT_CONFIG_DEFAULTS.inputPlaceholder,
  thinkingMessages: [...BOT_CONFIG_DEFAULTS.thinkingMessages],
  feedbackEnabled: BOT_CONFIG_DEFAULTS.feedbackEnabled,
  feedbackCollectReason: BOT_CONFIG_DEFAULTS.feedbackCollectReason,
  knowledgeEnabled: BOT_CONFIG_DEFAULTS.knowledgeEnabled,
  knowledgeStrictness: BOT_CONFIG_DEFAULTS.knowledgeStrictness,
  showSources: BOT_CONFIG_DEFAULTS.showSources,
  retrievalTopK: BOT_CONFIG_DEFAULTS.retrievalTopK,
  temperature: BOT_CONFIG_DEFAULTS.temperature,
  topP: BOT_CONFIG_DEFAULTS.topP,
  frequencyPenalty: BOT_CONFIG_DEFAULTS.frequencyPenalty,
  presencePenalty: BOT_CONFIG_DEFAULTS.presencePenalty,
  maxOutputTokens: BOT_CONFIG_DEFAULTS.maxOutputTokens,
  humanFallbackEnabled: BOT_CONFIG_DEFAULTS.humanFallbackEnabled,
  fallbackMessage: BOT_CONFIG_DEFAULTS.fallbackMessage,
  humanRequestBehavior: BOT_CONFIG_DEFAULTS.humanRequestBehavior,
  handoffMessage: BOT_CONFIG_DEFAULTS.handoffMessage,
  businessHours: BOT_CONFIG_DEFAULTS.businessHours,
  contactCollection: BOT_CONFIG_DEFAULTS.contactCollection,
});

/**
 * Project a stored row onto the typed columns, or the defaults when there is no row.
 *
 * Takes the row rather than fetching it, because every caller already has one in hand — and
 * two callers reading the same row twice in one request was a real cost for no benefit.
 */
const columnsFromRow = (row: BotConfiguration | null): ConfigColumns => {
  if (!row) return columnDefaults();

  return {
    displayName: row.displayName,
    personality: row.personality,
    tone: row.tone,
    customPersonality: row.customPersonality,
    customInstructions: row.customInstructions,
    responseLanguage: row.responseLanguage,
    responseLength: row.responseLength,
    welcomeMessage: row.welcomeMessage,
    conversationStarter: readJson<ConversationStarter>(row.conversationStarter),
    suggestedQuestions: readJson<string[]>(row.suggestedQuestions) ?? [],
    inputPlaceholder: row.inputPlaceholder,
    thinkingMessages: readJson<string[]>(row.thinkingMessages) ?? [],
    feedbackEnabled: row.feedbackEnabled,
    feedbackCollectReason: row.feedbackCollectReason,
    knowledgeEnabled: row.knowledgeEnabled,
    knowledgeStrictness: row.knowledgeStrictness,
    showSources: row.showSources,
    retrievalTopK: row.retrievalTopK,
    temperature: row.temperature,
    topP: row.topP,
    frequencyPenalty: row.frequencyPenalty,
    presencePenalty: row.presencePenalty,
    maxOutputTokens: row.maxOutputTokens,
    humanFallbackEnabled: row.humanFallbackEnabled,
    fallbackMessage: row.fallbackMessage,
    humanRequestBehavior: row.humanRequestBehavior,
    handoffMessage: row.handoffMessage,
    businessHours: readJson<BusinessHours>(row.businessHours),
    contactCollection: readJson<ContactCollection>(row.contactCollection),
  };
};

/** Read the stored columns for a bot, or the defaults when it has no configuration row. */
const readColumns = async (botId: string): Promise<ConfigColumns> =>
  columnsFromRow(await prisma.botConfiguration.findUnique({ where: { botId } }));

/**
 * Convert resolved columns into the data object Prisma accepts.
 *
 * Written out field by field rather than spread, because the five `Json` columns need
 * `DbNull`-or-value conversion and a spread would silently skip it. The explicitness is the
 * point: adding a column is a compile error here, which is exactly when you want to be
 * reminded that its JSON-ness needs deciding.
 */
const toPrismaData = (c: ConfigColumns) => ({
  displayName: c.displayName,
  personality: c.personality,
  tone: c.tone,
  customPersonality: c.customPersonality,
  customInstructions: c.customInstructions,
  responseLanguage: c.responseLanguage,
  responseLength: c.responseLength,
  welcomeMessage: c.welcomeMessage,
  conversationStarter: writeJson(c.conversationStarter),
  suggestedQuestions: c.suggestedQuestions as Prisma.InputJsonValue,
  inputPlaceholder: c.inputPlaceholder,
  thinkingMessages: c.thinkingMessages as Prisma.InputJsonValue,
  feedbackEnabled: c.feedbackEnabled,
  feedbackCollectReason: c.feedbackCollectReason,
  knowledgeEnabled: c.knowledgeEnabled,
  knowledgeStrictness: c.knowledgeStrictness,
  showSources: c.showSources,
  retrievalTopK: c.retrievalTopK,
  temperature: c.temperature,
  topP: c.topP,
  frequencyPenalty: c.frequencyPenalty,
  presencePenalty: c.presencePenalty,
  maxOutputTokens: c.maxOutputTokens,
  humanFallbackEnabled: c.humanFallbackEnabled,
  fallbackMessage: c.fallbackMessage,
  humanRequestBehavior: c.humanRequestBehavior,
  handoffMessage: c.handoffMessage,
  businessHours: writeJson(c.businessHours),
  contactCollection: writeJson(c.contactCollection),
});

/** The model facts `computeEffective` needs, resolved from the catalog (never a request). */
export interface ModelFacts {
  primary: { usable: boolean; capabilities: ModelCapabilities } | null;
  fallback: { usable: boolean; capabilities: ModelCapabilities } | null;
}

interface BotConfigRead {
  botId: string;
  isActive: boolean;
  aiModelId: string | null;
  fallbackAiModelId: string | null;
  avatarVersion: number;
  hasAvatar: boolean;
  version: number;
  updatedAt: Date | null;
  columns: ConfigColumns;
  models: ModelFacts;
}

/**
 * Read everything a configuration response needs, behind the membership gate.
 *
 * `getBotById` runs first and is what produces the 404 for a non-member — the configuration
 * read must not be reachable by any other path, and routing it through the same gate every
 * other bot-scoped service uses is what guarantees that.
 */
const readBotConfig = async (botId: string, userId: string): Promise<BotConfigRead> => {
  await getBotById(botId, userId);

  const [bot, row] = await Promise.all([
    prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      select: {
        isActive: true,
        aiModelId: true,
        fallbackAiModelId: true,
        aiModel: {
          select: {
            enabled: true,
            capabilities: true,
            provider: { select: { slug: true, enabled: true } },
          },
        },
        fallbackAiModel: {
          select: {
            enabled: true,
            capabilities: true,
            provider: { select: { slug: true, enabled: true } },
          },
        },
      },
    }),
    prisma.botConfiguration.findUnique({ where: { botId } }),
  ]);

  const toFacts = (
    model: { enabled: boolean; capabilities: unknown; provider: { slug: string; enabled: boolean } } | null
  ): { usable: boolean; capabilities: ModelCapabilities } | null =>
    model
      ? {
          usable: model.enabled && model.provider.enabled,
          capabilities: resolveCapabilities(model),
        }
      : null;

  return {
    botId,
    isActive: bot.isActive,
    aiModelId: bot.aiModelId,
    fallbackAiModelId: bot.fallbackAiModelId,
    avatarVersion: row?.avatarVersion ?? 0,
    hasAvatar: Boolean(row?.avatarData),
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
    columns: columnsFromRow(row),
    models: { primary: toFacts(bot.aiModel), fallback: toFacts(bot.fallbackAiModel) },
  };
};

/** Project the stored columns + bot state into the grouped wire shape (Appendix B). */
const toResolvedConfig = (read: BotConfigRead): ResolvedBotConfig => ({
  general: {
    isActive: read.isActive,
    displayName: read.columns.displayName,
    hasAvatar: read.hasAvatar,
    avatarVersion: read.avatarVersion,
  },
  personality: {
    preset: read.columns.personality,
    tone: read.columns.tone,
    customPersonality: read.columns.customPersonality,
    customInstructions: read.columns.customInstructions,
    responseLanguage: read.columns.responseLanguage,
    responseLength: read.columns.responseLength,
  },
  conversation: {
    welcomeMessage: read.columns.welcomeMessage,
    conversationStarter: read.columns.conversationStarter,
    suggestedQuestions: read.columns.suggestedQuestions,
    inputPlaceholder: read.columns.inputPlaceholder,
    thinkingMessages: read.columns.thinkingMessages,
    feedbackEnabled: read.columns.feedbackEnabled,
    feedbackCollectReason: read.columns.feedbackCollectReason,
  },
  knowledge: {
    enabled: read.columns.knowledgeEnabled,
    strictness: read.columns.knowledgeStrictness,
    showSources: read.columns.showSources,
    topK: read.columns.retrievalTopK,
  },
  generation: {
    temperature: read.columns.temperature,
    topP: read.columns.topP,
    frequencyPenalty: read.columns.frequencyPenalty,
    presencePenalty: read.columns.presencePenalty,
    maxOutputTokens: read.columns.maxOutputTokens,
  },
  model: {
    aiModelId: read.aiModelId,
    fallbackAiModelId: read.fallbackAiModelId,
  },
  humanSupport: {
    fallbackEnabled: read.columns.humanFallbackEnabled,
    fallbackMessage: read.columns.fallbackMessage,
    humanRequestBehavior: read.columns.humanRequestBehavior,
    handoffMessage: read.columns.handoffMessage,
    businessHours: read.columns.businessHours,
    contactCollection: read.columns.contactCollection,
  },
});

/**
 * The honest projection of stored intent against the resolved models (§10.1, §12.3).
 *
 * `ignoredParams` is what lets the UI disable a control **without clearing the value**: an
 * owner who swaps to a model that cannot take penalties sees them greyed out, and their
 * settings are still there when they swap back. Losing settings in order to change models
 * would be the wrong trade, so nothing here is ever a validation error.
 */
export const computeEffective = (config: ResolvedBotConfig, models: ModelFacts): EffectiveInfo => {
  // The model that will actually serve: primary if usable, otherwise the fallback (§13.2).
  const serving = models.primary?.usable ? models.primary : models.fallback?.usable ? models.fallback : null;
  const caps = serving?.capabilities;

  const applied: EffectiveInfo['appliedParams'] = {};
  const ignored: GenerationParamName[] = [];

  const consider = (
    name: GenerationParamName,
    value: number | null,
    supported: boolean | undefined,
    assign: (v: number) => void
  ): void => {
    if (value === null || value === undefined) return;
    if (caps && supported === false) {
      ignored.push(name);
      return;
    }
    assign(value);
  };

  // `temperature` is never null (it has a real default of 0.0), so it is reported as
  // ignored whenever the serving model cannot take it — which is accurate and is the only
  // signal an owner gets that their sampling choice is doing nothing.
  consider('temperature', config.generation.temperature, caps?.temperature, (v) => {
    applied.temperature = v;
  });
  consider('topP', config.generation.topP, caps?.topP, (v) => {
    applied.topP = v;
  });
  consider('frequencyPenalty', config.generation.frequencyPenalty, caps?.frequencyPenalty, (v) => {
    applied.frequencyPenalty = v;
  });
  consider('presencePenalty', config.generation.presencePenalty, caps?.presencePenalty, (v) => {
    applied.presencePenalty = v;
  });

  // `responseLength` is a fallback for the token cap, so it only becomes an applied param
  // when the owner has not set an explicit cap of their own (§19.2 rule 7).
  const tokenCap =
    config.generation.maxOutputTokens ?? RESPONSE_LENGTH_PRESETS[config.personality.responseLength].maxTokens;
  consider('maxTokens', tokenCap, caps?.maxTokens, (v) => {
    applied.maxTokens = v;
  });

  return {
    appliedParams: applied,
    ignoredParams: ignored,
    // The primary is unusable but something is serving: the UI must say so (§13.2).
    modelPromoted: Boolean(models.primary && !models.primary.usable && models.fallback?.usable),
    modelUnavailable: !serving,
    knowledgeActive: false, // filled in by the async wrapper below, which can count chunks
  };
};

/** Build the full `{ config, effective, version }` response for a bot. */
export const getBotConfigResponse = async (
  botId: string,
  userId: string
): Promise<BotConfigResponse> => {
  const read = await readBotConfig(botId, userId);
  const config = toResolvedConfig(read);
  const effective = computeEffective(config, read.models);

  // "Knowledge is on" and "this bot actually has knowledge" are different facts, and the
  // second is the one that explains why answers still fall back on an empty bot (§15.1).
  if (config.knowledge.enabled) {
    const enabledChunks = await prisma.knowledgeChunk.count({ where: { botId, enabled: true } });
    effective.knowledgeActive = enabledChunks > 0;
  }

  return {
    config,
    effective,
    version: read.version,
    updatedAt: read.updatedAt ? read.updatedAt.toISOString() : null,
  };
};

/** Map the flat PATCH body onto Prisma columns, dropping the concurrency token. */
const toColumnPatch = (input: UpdateBotConfigInput | ResolvedBotConfigInput) => {
  const { expectedVersion: _expectedVersion, ...columns } = input as Record<string, unknown> & {
    expectedVersion?: number;
  };
  return columns;
};

/**
 * Apply a partial configuration update (§10.1, §22).
 *
 * The order is deliberate: membership (404) → version (409) → merge → invariants (400) →
 * write. Validating before the membership gate would let a non-member probe the schema
 * through error codes, which is the same oracle `assignBotModel`'s docstring warns about.
 */
export const updateBotConfig = async (
  botId: string,
  userId: string,
  input: UpdateBotConfigInput
): Promise<BotConfigResponse> => {
  await getBotById(botId, userId);

  const row = await prisma.botConfiguration.findUnique({ where: { botId } });
  const storedVersion = row?.version ?? 0;

  if (storedVersion !== input.expectedVersion) {
    // 409 carries the *current* state so the client can offer "reload" or "keep mine"
    // without a second round trip (§16.2). Never a silent overwrite.
    const current = await getBotConfigResponse(botId, userId);
    throw new AppError(
      'This bot was changed by someone else. Reload to see the latest configuration.',
      409,
      true,
      current
    );
  }

  const merged: ConfigColumns = {
    ...columnsFromRow(row),
    ...(toColumnPatch(input) as Partial<ConfigColumns>),
  };

  // Forced, not rejected: turning knowledge off with sources on is a state the owner reaches
  // by accident, and the honest resolution is to stop claiming sources exist (§19.2 rule 3).
  if (!merged.knowledgeEnabled) {
    merged.showSources = false;
  }

  const validated = resolvedBotConfigSchema.safeParse(merged);
  if (!validated.success) {
    const message = validated.error.issues.map((issue) => issue.message).join('; ');
    throw new AppError(message, 400);
  }

  await prisma.botConfiguration.upsert({
    where: { botId },
    create: { botId, ...toPrismaData(merged), version: 1 },
    update: { ...toPrismaData(merged), version: { increment: 1 } },
  });

  logger.info({ botId, version: storedVersion + 1 }, 'Bot configuration updated');

  return getBotConfigResponse(botId, userId);
};

/** Which columns each reset section restores (§8.3). */
const SECTION_COLUMNS: Record<string, Array<keyof ConfigColumns>> = {
  general: ['displayName'],
  personality: [
    'personality',
    'tone',
    'customPersonality',
    'customInstructions',
    'responseLanguage',
    'responseLength',
  ],
  conversation: [
    'welcomeMessage',
    'conversationStarter',
    'suggestedQuestions',
    'inputPlaceholder',
    'thinkingMessages',
    'feedbackEnabled',
    'feedbackCollectReason',
  ],
  knowledge: ['knowledgeEnabled', 'knowledgeStrictness', 'showSources', 'retrievalTopK'],
  generation: ['temperature', 'topP', 'frequencyPenalty', 'presencePenalty', 'maxOutputTokens'],
  humanSupport: [
    'humanFallbackEnabled',
    'fallbackMessage',
    'humanRequestBehavior',
    'handoffMessage',
    'businessHours',
    'contactCollection',
  ],
  appearance: ['displayName'],
};

/**
 * Restore one section (or everything) to the recommended defaults (§8.3).
 *
 * The avatar is deliberately **not** cleared by a plain reset. Deleting a person's uploaded
 * image as a side effect of "reset appearance" is destructive and irreversible, so it takes
 * `includeAvatar: true` — an explicit second decision.
 */
export const resetBotConfig = async (
  botId: string,
  userId: string,
  input: ResetBotConfigInput
): Promise<BotConfigResponse> => {
  await getBotById(botId, userId);

  const row = await prisma.botConfiguration.findUnique({ where: { botId } });
  const storedVersion = row?.version ?? 0;

  if (storedVersion !== input.expectedVersion) {
    const current = await getBotConfigResponse(botId, userId);
    throw new AppError(
      'This bot was changed by someone else. Reload to see the latest configuration.',
      409,
      true,
      current
    );
  }

  const defaults = columnDefaults();
  const columns =
    input.section === 'all'
      ? (Object.keys(SECTION_COLUMNS).flatMap((key) => SECTION_COLUMNS[key] as Array<keyof ConfigColumns>))
      : (SECTION_COLUMNS[input.section] ?? []);

  const patch: Partial<ConfigColumns> = {};
  for (const column of new Set(columns)) {
    Object.assign(patch, { [column]: defaults[column] });
  }

  // `general` and `appearance` also cover the operational state, which lives on `Bot`.
  if (input.section === 'general' || input.section === 'all') {
    await prisma.bot.update({ where: { id: botId }, data: { isActive: true } });
  }

  // Only the reset columns are written, so resetting one section cannot silently revert an
  // owner's work in another.
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    data[key] = NULLABLE_JSON_COLUMNS.has(key as keyof ConfigColumns) ? writeJson(value) : value;
  }
  data.version = { increment: 1 };

  if ((input.section === 'appearance' || input.section === 'all') && input.includeAvatar) {
    Object.assign(data, {
      avatarData: null,
      avatarMimeType: null,
      avatarUpdatedAt: null,
      avatarVersion: { increment: 1 },
    });
  }

  await prisma.botConfiguration.upsert({
    where: { botId },
    create: { botId, ...toPrismaData({ ...defaults, ...patch }), version: 1 },
    update: data as Prisma.BotConfigurationUpdateInput,
  });

  logger.info({ botId, section: input.section }, 'Bot configuration section reset');

  return getBotConfigResponse(botId, userId);
};

/**
 * The projection Python receives (§11.1) — snake_case, and **only** the fields the AI
 * service understands.
 *
 * Note what is absent: welcome messages, suggested questions, placeholder copy, business
 * hours, feedback flags, contact fields. Those are client rendering and Node policy. Sending
 * them would invite the AI service to grow an opinion about product behaviour, which is the
 * boundary this whole design rests on.
 */
export const toPythonConfig = (config: ResolvedBotConfig) => ({
  personality: config.personality.preset,
  tone: config.personality.tone,
  custom_personality: config.personality.customPersonality,
  custom_instructions: config.personality.customInstructions,
  response_language: config.personality.responseLanguage,
  response_length: config.personality.responseLength,
  knowledge: {
    enabled: config.knowledge.enabled,
    strictness: config.knowledge.strictness,
    show_sources: config.knowledge.showSources,
    top_k: config.knowledge.topK,
  },
  params: {
    temperature: config.generation.temperature,
    top_p: config.generation.topP,
    frequency_penalty: config.generation.frequencyPenalty,
    presence_penalty: config.generation.presencePenalty,
    max_tokens:
      config.generation.maxOutputTokens ??
      RESPONSE_LENGTH_PRESETS[config.personality.responseLength].maxTokens,
  },
  fallback: { message: config.humanSupport.fallbackMessage },
});

/** The model facts (enablement + capabilities) for the preview's `effective` projection. */
const readModelFacts = async (botId: string): Promise<ModelFacts> => {
  const bot = await prisma.bot.findUniqueOrThrow({
    where: { id: botId },
    select: {
      aiModel: {
        select: {
          enabled: true,
          capabilities: true,
          provider: { select: { slug: true, enabled: true } },
        },
      },
      fallbackAiModel: {
        select: {
          enabled: true,
          capabilities: true,
          provider: { select: { slug: true, enabled: true } },
        },
      },
    },
  });

  const toFacts = (
    model: { enabled: boolean; capabilities: unknown; provider: { slug: string; enabled: boolean } } | null
  ): { usable: boolean; capabilities: ModelCapabilities } | null =>
    model
      ? { usable: model.enabled && model.provider.enabled, capabilities: resolveCapabilities(model) }
      : null;

  return { primary: toFacts(bot.aiModel), fallback: toFacts(bot.fallbackAiModel) };
};

/** The preview response shape (§17.2). */
export interface PreviewResult {
  response: string;
  fallback_required: boolean;
  reason?: string;
  sources?: SourceRef[] | null;
  appliedParams: EffectiveInfo['appliedParams'];
  ignoredParams: GenerationParamName[];
}

/**
 * Test a draft configuration against the bot's real knowledge base (§17.2).
 *
 * Three properties make this safe and useful:
 *   - **Nothing is persisted.** This function never calls a `create`/`update`; a test asserts
 *     the Prisma write mocks stay untouched.
 *   - **Models come from the bot's STORED ids**, never the draft. The draft's `model` field is
 *     ignored, so a client cannot name an arbitrary model and bypass the catalog.
 *   - **The pipeline is the production one** — the same `POST /api/v1/chat`, with the draft
 *     projected through `toPythonConfig`. No debugger: the response carries the answer, the
 *     optional sources and the fallback state, and nothing else.
 */
export const previewConfig = async (
  botId: string,
  userId: string,
  input: PreviewConfigInput
): Promise<PreviewResult> => {
  await getBotById(botId, userId);

  const draft = input.draft as unknown as ResolvedBotConfig;

  const [resolution, modelFacts] = await Promise.all([
    resolveBotModel(botId),
    readModelFacts(botId),
  ]);
  const effective = computeEffective(draft, modelFacts);

  if (!resolution.ok) {
    return {
      response: MODEL_UNAVAILABLE_MESSAGE,
      fallback_required: true,
      reason: resolution.reason,
      appliedParams: effective.appliedParams,
      ignoredParams: effective.ignoredParams,
    };
  }

  const ai = await aiServiceClient.chat({
    bot_id: botId,
    message: input.message,
    ...(resolution.model ? { model: resolution.model } : {}),
    ...(resolution.fallbackModel ? { fallback_model: resolution.fallbackModel } : {}),
    config: toPythonConfig(draft),
  });

  const sources = draft.knowledge.showSources
    ? await resolveSourceLabels(ai.sources, botId)
    : null;

  return {
    response: ai.response,
    fallback_required: ai.fallback_required,
    ...(ai.reason ? { reason: ai.reason } : {}),
    ...(sources ? { sources } : {}),
    appliedParams: effective.appliedParams,
    ignoredParams: effective.ignoredParams,
  };
};

/** Resolve the config for the message-send path, without the membership gate. */
export const resolveBotConfigForChat = async (botId: string): Promise<ResolvedBotConfig> => {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { isActive: true, aiModelId: true, fallbackAiModelId: true },
  });

  if (!bot) {
    throw new NotFoundError('Bot not found');
  }

  const row = await prisma.botConfiguration.findUnique({ where: { botId } });

  return toResolvedConfig({
    botId,
    isActive: bot.isActive,
    aiModelId: bot.aiModelId,
    fallbackAiModelId: bot.fallbackAiModelId,
    avatarVersion: row?.avatarVersion ?? 0,
    hasAvatar: Boolean(row?.avatarData),
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
    columns: columnsFromRow(row),
    models: { primary: null, fallback: null },
  });
};
