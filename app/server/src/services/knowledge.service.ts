import type { KnowledgeEntry } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';
import { getBotById } from './bot.service.js';
import type { CreateKnowledgeInput, UpdateKnowledgeInput } from '../schemas/knowledge.schema.js';
import { aiServiceClient } from './aiServiceClient.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/errors.js';

/** Add a knowledge (FAQ) entry to a bot in a workspace the caller belongs to. */
export const createKnowledge = async (
  botId: string,
  userId: string,
  input: CreateKnowledgeInput
): Promise<KnowledgeEntry> => {
  await getBotById(botId, userId);

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

/** List a bot's knowledge entries (after asserting access to the bot). */
export const listKnowledgeByBot = async (
  botId: string,
  userId: string
): Promise<KnowledgeEntry[]> => {
  await getBotById(botId, userId);

  return prisma.knowledgeEntry.findMany({
    where: { botId },
    orderBy: { createdAt: 'desc' },
  });
};

/**
 * Fetch a knowledge entry via the full chain (entry -> bot -> workspace -> membership),
 * or throw 404. A non-member gets the same 404 as a missing entry.
 */
export const getKnowledgeById = async (
  knowledgeId: string,
  userId: string
): Promise<KnowledgeEntry> => {
  const entry = await prisma.knowledgeEntry.findFirst({
    where: { id: knowledgeId, bot: { workspace: { members: { some: { userId } } } } },
  });

  if (!entry) {
    throw new NotFoundError('Knowledge entry not found');
  }

  return entry;
};

/** Update a knowledge entry after asserting workspace membership. */
export const updateKnowledge = async (
  knowledgeId: string,
  userId: string,
  input: UpdateKnowledgeInput
): Promise<KnowledgeEntry> => {
  await getKnowledgeById(knowledgeId, userId);

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

/** Delete a knowledge entry after asserting workspace membership. */
export const deleteKnowledge = async (knowledgeId: string, _userId: string): Promise<void> => {
  throw new AppError('Deleting specific knowledge entries is coming soon. Please delete all knowledge for the bot.', 501);
};

/**
 * Delete every FAQ entry for a bot, and the vectors they produced.
 *
 * **Scoped to the entries' own ids, not to the bot.** A bot's vectors come from two
 * sources — hand-written FAQ entries and uploaded documents — and they share one pgvector
 * table, distinguished only by `source_id` (an entry id here, a `knowledge_sources` row id
 * there). The obvious call, `deleteBotKnowledge(botId)`, takes every vector the bot owns:
 * the documents would survive in the UI, their `knowledge_chunks_meta` rows would survive
 * in this database, and every one of them would have stopped being searchable with nothing
 * recording why. Naming the entry ids removes exactly what the button says it removes.
 *
 * The entry ids are read *before* the rows are deleted, because afterwards there is
 * nothing left to derive them from — and an orphaned vector is unreachable, since a
 * `source_id` is the only handle that identifies it.
 *
 * The vector call is attempted even though the rows are already gone, and its failure is
 * logged rather than thrown: the user asked for the FAQs to be gone, and they are. Failing
 * the request would report an error for work that succeeded, and the retry would find no
 * entries to name — so the orphans could never be cleaned up at all.
 */
export const deleteAllKnowledge = async (botId: string, userId: string): Promise<void> => {
  await getBotById(botId, userId);

  const entries = await prisma.knowledgeEntry.findMany({
    where: { botId },
    select: { id: true },
  });

  await prisma.knowledgeEntry.deleteMany({ where: { botId } });

  if (entries.length === 0) return;

  try {
    await aiServiceClient.bulkDeleteSourceVectors(botId, entries.map((entry) => entry.id));
  } catch (err) {
    logger.error({ err, botId, entryCount: entries.length }, 'Failed to delete knowledge from AI service');
  }
};
