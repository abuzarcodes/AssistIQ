import type { KnowledgeEntry } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { getBotById } from './bot.service.js';
import type { CreateKnowledgeInput, UpdateKnowledgeInput } from '../schemas/knowledge.schema.js';

/** Add a knowledge (FAQ) entry to a bot the caller owns. */
export const createKnowledge = async (
  botId: string,
  ownerId: string,
  input: CreateKnowledgeInput
): Promise<KnowledgeEntry> => {
  await getBotById(botId, ownerId);

  return prisma.knowledgeEntry.create({
    data: {
      botId,
      title: input.title,
      category: input.category,
      question: input.question,
      answer: input.answer,
    },
  });
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
  await getKnowledgeById(knowledgeId, ownerId);
  await prisma.knowledgeEntry.delete({ where: { id: knowledgeId } });
};
