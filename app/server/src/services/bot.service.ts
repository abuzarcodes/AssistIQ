import type { Bot } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { getWorkspaceById } from './workspace.service.js';
import type { CreateBotInput, UpdateBotInput } from '../schemas/bot.schema.js';
import { aiServiceClient } from './aiServiceClient.js';
import { logger } from '../config/logger.js';

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
export const listBotsByWorkspace = async (workspaceId: string, userId: string): Promise<Bot[]> => {
  await getWorkspaceById(workspaceId, userId);

  return prisma.bot.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
};

/**
 * Fetch a bot that lives in a workspace the caller belongs to, or throw 404.
 * Reused as the scope gate for knowledge/conversation resources nested under a bot.
 */
export const getBotById = async (botId: string, userId: string): Promise<Bot> => {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, workspace: { members: { some: { userId } } } },
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
): Promise<Bot> => {
  await getBotById(botId, userId);

  // Undefined fields are ignored by Prisma; an explicit null clears the description.
  return prisma.bot.update({
    where: { id: botId },
    data: { name: input.name, description: input.description },
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
