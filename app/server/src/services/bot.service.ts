import type { Bot } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { getWorkspaceById } from './workspace.service.js';
import type { CreateBotInput, UpdateBotInput } from '../schemas/bot.schema.js';
import { aiServiceClient } from './aiServiceClient.js';
import { logger } from '../config/logger.js';

/**
 * Create a bot under a workspace. Ownership of the parent workspace is asserted first,
 * so a user can never plant a bot in someone else's workspace.
 */
export const createBot = async (
  workspaceId: string,
  ownerId: string,
  input: CreateBotInput
): Promise<Bot> => {
  await getWorkspaceById(workspaceId, ownerId);

  return prisma.bot.create({
    data: {
      name: input.name,
      description: input.description,
      workspaceId,
    },
  });
};

/** List a workspace's bots (after asserting the caller owns the workspace). */
export const listBotsByWorkspace = async (workspaceId: string, ownerId: string): Promise<Bot[]> => {
  await getWorkspaceById(workspaceId, ownerId);

  return prisma.bot.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
  });
};

/**
 * Fetch a bot the caller owns (via workspace ownership), or throw 404.
 * Reused as the ownership gate for knowledge/conversation resources nested under a bot.
 */
export const getBotById = async (botId: string, ownerId: string): Promise<Bot> => {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, workspace: { ownerId } },
  });

  if (!bot) {
    throw new NotFoundError('Bot not found');
  }

  return bot;
};

/** Update a bot's name/description after asserting ownership. */
export const updateBot = async (
  botId: string,
  ownerId: string,
  input: UpdateBotInput
): Promise<Bot> => {
  await getBotById(botId, ownerId);

  // Undefined fields are ignored by Prisma; an explicit null clears the description.
  return prisma.bot.update({
    where: { id: botId },
    data: { name: input.name, description: input.description },
  });
};

/**
 * Delete a bot after asserting ownership. Related knowledge, conversations, and
 * messages are removed by the schema's cascade rules (spec §11).
 */
export const deleteBot = async (botId: string, ownerId: string): Promise<void> => {
  await getBotById(botId, ownerId);
  await prisma.bot.delete({ where: { id: botId } });

  try {
    await aiServiceClient.deleteBotKnowledge(botId);
  } catch (err) {
    logger.error({ err, botId }, 'Failed to delete knowledge vectors from AI service during bot deletion');
  }
};
