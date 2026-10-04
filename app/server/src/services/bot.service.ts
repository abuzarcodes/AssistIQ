import type { Bot, Prisma } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { getWorkspaceById } from './workspace.service.js';
import type { CreateBotInput, UpdateBotInput } from '../schemas/bot.schema.js';
import { aiServiceClient } from './aiServiceClient.js';
import { logger } from '../config/logger.js';

/**
 * The only shape in which a bot's assigned model is ever projected (Checkpoint 3).
 *
 * `providerModelId` is deliberately absent: the provider-native id is an implementation
 * detail, and returning it would invite a client to try to use it directly instead of going
 * through the catalog. `enabled` flags are included so the UI can warn about a model that
 * has since been switched off without a second request.
 */
export const aiModelSelect = {
  id: true,
  displayName: true,
  enabled: true,
  provider: { select: { slug: true, name: true, enabled: true } },
} as const;

/** A bot as returned by the read endpoints: with both models, but never a provider id. */
export type BotWithModel = Prisma.BotGetPayload<{
  include: {
    aiModel: { select: typeof aiModelSelect };
    fallbackAiModel: { select: typeof aiModelSelect };
  };
}>;

/**
 * The model projection every bot read carries, for both the primary and the failover
 * (§10.3). Both use the same select, so the failover model is described in exactly the same
 * terms as the primary — a client rendering the pair has one shape to handle.
 */
const withModel = {
  aiModel: { select: aiModelSelect },
  fallbackAiModel: { select: aiModelSelect },
} as const;

/**
 * Create a bot under a workspace. The caller's membership of the parent workspace is
 * asserted first, so a user can never plant a bot in a workspace they do not belong to.
 */
export const createBot = async (
  workspaceId: string,
  userId: string,
  input: CreateBotInput
): Promise<Bot> => {
  await getWorkspaceById(workspaceId, userId);

  return prisma.bot.create({
    data: {
      name: input.name,
      description: input.description,
      workspaceId,
    },
  });
};

/** List a workspace's bots (after asserting the caller is a member of the workspace). */
export const listBotsByWorkspace = async (
  workspaceId: string,
  userId: string
): Promise<BotWithModel[]> => {
  await getWorkspaceById(workspaceId, userId);

  return prisma.bot.findMany({
    where: { workspaceId },
    include: withModel,
    orderBy: { createdAt: 'desc' },
  });
};

/**
 * Fetch a bot that lives in a workspace the caller belongs to, or throw 404.
 * Reused as the scope gate for knowledge/conversation resources nested under a bot.
 */
export const getBotById = async (botId: string, userId: string): Promise<BotWithModel> => {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, workspace: { members: { some: { userId } } } },
    include: withModel,
  });

  if (!bot) {
    throw new NotFoundError('Bot not found');
  }

  return bot;
};

/** Update a bot's name/description/paused state after asserting workspace membership. */
export const updateBot = async (
  botId: string,
  userId: string,
  input: UpdateBotInput
): Promise<BotWithModel> => {
  await getBotById(botId, userId);

  // Undefined fields are ignored by Prisma; an explicit null clears the description.
  return prisma.bot.update({
    where: { id: botId },
    data: {
      name: input.name,
      description: input.description,
      isActive: input.isActive,
    },
    include: withModel,
  });
};

/**
 * Assign a catalog model to a bot, or clear the assignment with `null`.
 *
 * Two fields are now assignable — the primary and the failover (§10.3) — and each is
 * validated by the same ladder. Order matters and is deliberate:
 *
 *   1. **Membership first** (`getBotById` → 404 for a non-member). Validating the model
 *      before this would let a non-member probe the catalog through error codes: a 400 for
 *      an unknown model and a 200 for a known one is an oracle.
 *   2. **Then the models**, resolved through the database by internal id. A provider-native
 *      id cannot reach this function — `assignModelSchema` rejects a non-uuid with a 400.
 *   3. A model that exists but is **disabled**, or whose **provider is disabled**, is a 400
 *      rather than a 404: the caller is an already-verified member, so there is nothing to
 *      conceal, and "you cannot select this" is the accurate answer.
 *
 * Clearing to `null` skips validation entirely — it is always permitted, at any time, for
 * any bot.
 *
 * **The "must differ from the other field" check runs after the membership gate**, against
 * the *stored* values. `assignModelSchema` can only catch the case where both ids arrive in
 * one body; a request naming just one of them can only be checked here. Doing it before the
 * gate would reintroduce exactly the oracle step 1 exists to close.
 */
export const assignBotModel = async (
  botId: string,
  userId: string,
  input: { aiModelId?: string | null; fallbackAiModelId?: string | null }
): Promise<BotWithModel> => {
  const bot = await getBotById(botId, userId);

  const checkModel = async (modelId: string): Promise<void> => {
    const model = await prisma.aIModel.findUnique({
      where: { id: modelId },
      select: { id: true, enabled: true, provider: { select: { enabled: true } } },
    });

    if (!model) {
      throw new ValidationError('Unknown model');
    }
    if (!model.enabled) {
      throw new ValidationError('That model is not enabled');
    }
    if (!model.provider.enabled) {
      throw new ValidationError('That model’s provider is not enabled');
    }
  };

  if (typeof input.aiModelId === 'string') {
    await checkModel(input.aiModelId);
  }
  if (typeof input.fallbackAiModelId === 'string') {
    await checkModel(input.fallbackAiModelId);
  }

  // The effective pair after this request: what was sent, else what is stored. A single
  // read, so a request that names only the fallback is still checked against the primary
  // the bot actually has.
  const nextPrimary = input.aiModelId !== undefined ? input.aiModelId : bot.aiModelId;
  const nextFallback =
    input.fallbackAiModelId !== undefined ? input.fallbackAiModelId : bot.fallbackAiModelId;

  if (nextPrimary !== null && nextPrimary === nextFallback) {
    throw new ValidationError('The fallback model must differ from the primary model');
  }

  // Only the fields the caller actually sent are written. Spreading both would turn
  // "change the fallback" into "also re-assert the primary", which would clobber a
  // concurrent change to the primary that this request never intended to touch.
  return prisma.bot.update({
    where: { id: botId },
    data: {
      ...(input.aiModelId !== undefined ? { aiModelId: input.aiModelId } : {}),
      ...(input.fallbackAiModelId !== undefined
        ? { fallbackAiModelId: input.fallbackAiModelId }
        : {}),
    },
    include: withModel,
  });
};

/**
 * Delete a bot after asserting workspace membership. Related knowledge, conversations,
 * and messages are removed by the schema's cascade rules (spec §11).
 *
 * **The vector deletion runs before the row deletion, and that order is the point.** The
 * two stores cannot be deleted atomically — the vectors live in a different PostgreSQL
 * database behind the AI service — so one of them has to go first, and the question is
 * which failure is recoverable.
 *
 * Deleting the rows first makes the vector call unrecoverable on failure: the bot is gone,
 * so every later request is a 404, and no operator action can reach those vectors again —
 * they keep being retrieved for a bot that no longer exists. Calling the AI service first
 * fails the other way: a successful vector delete followed by a failed row delete leaves a
 * bot whose vectors are gone and whose rows remain, which a retry fixes (the second vector
 * delete removes nothing and the row delete then succeeds). A failure here is still logged
 * rather than thrown — an AI outage must not make a bot undeletable — and the bot is
 * removed either way, so the terminal state is unchanged from before.
 */
export const deleteBot = async (botId: string, userId: string): Promise<void> => {
  await getBotById(botId, userId);

  try {
    await aiServiceClient.deleteBotKnowledge(botId);
  } catch (err) {
    logger.error({ err, botId }, 'Failed to delete knowledge vectors from AI service during bot deletion');
  }

  await prisma.bot.delete({ where: { id: botId } });
};
