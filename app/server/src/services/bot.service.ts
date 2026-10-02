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

/** A bot as returned by the read endpoints: with its model, but never its provider id. */
export type BotWithModel = Prisma.BotGetPayload<{
  include: { aiModel: { select: typeof aiModelSelect } };
}>;

const withModel = { aiModel: { select: aiModelSelect } } as const;

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

/** Update a bot's name/description after asserting workspace membership. */
export const updateBot = async (
  botId: string,
  userId: string,
  input: UpdateBotInput
): Promise<BotWithModel> => {
  await getBotById(botId, userId);

  // Undefined fields are ignored by Prisma; an explicit null clears the description.
  return prisma.bot.update({
    where: { id: botId },
    data: { name: input.name, description: input.description },
    include: withModel,
  });
};

/**
 * Assign a catalog model to a bot, or clear the assignment with `null` (Checkpoint 3).
 *
 * Order matters and is deliberate:
 *
 *   1. **Membership first** (`getBotById` → 404 for a non-member). Validating the model
 *      before this would let a non-member probe the catalog through error codes: a 400 for
 *      an unknown model and a 200 for a known one is an oracle.
 *   2. **Then the model**, resolved through the database by internal id. A provider-native
 *      id cannot reach this function — `assignModelSchema` rejects a non-uuid with a 400.
 *   3. A model that exists but is **disabled**, or whose **provider is disabled**, is a 400
 *      rather than a 404: the caller is an already-verified member, so there is nothing to
 *      conceal, and "you cannot select this" is the accurate answer.
 *
 * Clearing to `null` skips validation entirely — it is always permitted, at any time, for
 * any bot.
 */
export const assignBotModel = async (
  botId: string,
  userId: string,
  aiModelId: string | null
): Promise<BotWithModel> => {
  await getBotById(botId, userId);

  if (aiModelId !== null) {
    const model = await prisma.aIModel.findUnique({
      where: { id: aiModelId },
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
  }

  return prisma.bot.update({
    where: { id: botId },
    data: { aiModelId },
    include: withModel,
  });
};

/**
 * Delete a bot after asserting workspace membership. Related knowledge, conversations,
 * and messages are removed by the schema's cascade rules (spec §11).
 */
export const deleteBot = async (botId: string, userId: string): Promise<void> => {
  await getBotById(botId, userId);
  await prisma.bot.delete({ where: { id: botId } });

  try {
    await aiServiceClient.deleteBotKnowledge(botId);
  } catch (err) {
    logger.error({ err, botId }, 'Failed to delete knowledge vectors from AI service during bot deletion');
  }
};
