import type { KnowledgeEntry } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { getBotById } from './bot.service.js';
import type { CreateKnowledgeInput, UpdateKnowledgeInput } from '../schemas/knowledge.schema.js';
import { aiServiceClient } from './aiServiceClient.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/errors.js';

/** Add a knowledge (FAQ) entry to a bot the caller owns. */
export const createKnowledge = async (
  botId: string,
  ownerId: string,
  input: CreateKnowledgeInput
): Promise<KnowledgeEntry> => {
  await getBotById(botId, ownerId);

  let category = input.category;
  if (!category) {
    try {
      const classification = await aiServiceClient.classifyIntent({ 
        text: `${input.title || ''} ${input.question} ${input.answer}` 
      });
      category = classification.intent;
    } catch (err) {
      logger.warn({ err }, 'Failed to classify intent for new knowledge');
    }
  }

  const entry = await prisma.knowledgeEntry.create({
    data: {
      botId,
      title: input.title,
      category,
      question: input.question,
      answer: input.answer,
    },
  });

  try {
    await aiServiceClient.ingestKnowledge({
      bot_id: botId,
      entries: [{
        id: entry.id,
        topic: entry.category || 'General',
        content: `Q: ${entry.question}\nA: ${entry.answer}`
      }],
    });
  } catch (err) {
    logger.error({ err, botId }, 'Failed to ingest knowledge to AI service');
    // We don't rollback the DB here, as the knowledge is saved, but we log the failure.
  }

  return entry;
};

/** List a bot's knowledge entries (after asserting ownership of the bot). */
export const listKnowledgeByBot = async (
  botId: string,
  ownerId: string
): Promise<KnowledgeEntry[]> => {
  await getBotById(botId, ownerId);

  return prisma.knowledgeEntry.findMany({
    where: { botId },
    orderBy: { createdAt: 'desc' },
  });
};

/**
 * Fetch a knowledge entry the caller owns via the full chain
 * (entry -> bot -> workspace -> owner), or throw 404.
 */
export const getKnowledgeById = async (
  knowledgeId: string,
  ownerId: string
): Promise<KnowledgeEntry> => {
  const entry = await prisma.knowledgeEntry.findFirst({
    where: { id: knowledgeId, bot: { workspace: { ownerId } } },
  });

  if (!entry) {
    throw new NotFoundError('Knowledge entry not found');
  }

  return entry;
};

/** Update a knowledge entry after asserting ownership. */
export const updateKnowledge = async (
  knowledgeId: string,
  ownerId: string,
  input: UpdateKnowledgeInput
): Promise<KnowledgeEntry> => {
  await getKnowledgeById(knowledgeId, ownerId);

  return prisma.knowledgeEntry.update({
    where: { id: knowledgeId },
    data: {
      title: input.title,
      category: input.category,
      question: input.question,
      answer: input.answer,
    },
  });
};

/** Delete a knowledge entry after asserting ownership. */
export const deleteKnowledge = async (knowledgeId: string, ownerId: string): Promise<void> => {
  throw new AppError('Deleting specific knowledge entries is coming soon. Please delete all knowledge for the bot.', 501);
};

/** Delete all knowledge entries for a bot */
export const deleteAllKnowledge = async (botId: string, ownerId: string): Promise<void> => {
  await getBotById(botId, ownerId);
  await prisma.knowledgeEntry.deleteMany({ where: { botId } });
  
  try {
    await aiServiceClient.deleteBotKnowledge(botId);
  } catch (err) {
    logger.error({ err, botId }, 'Failed to delete knowledge from AI service');
  }
};
