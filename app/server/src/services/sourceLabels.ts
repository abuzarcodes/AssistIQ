import prisma from '../config/database.js';
import type { PythonSourceRef } from './aiServiceClient.js';
import type { SourceRef } from '../types/botConfig.types.js';

/**
 * Resolve display-safe citation labels (docs/BOT_IMPLEMENTATION_PLAN.md §15.3).
 *
 * Node owns the labels: the AI service returns **identifiers only**, and `KnowledgeSource`
 * rows live here. FAQ chunks have no source row, so they are labelled "FAQ entry" rather
 * than showing a blank filename — the same distinction the retrieval tester already draws.
 *
 * Extracted into its own module so both the conversation read path and the preview can use
 * it without a circular import between the two services.
 */
export const resolveSourceLabels = async (
  sources: PythonSourceRef[] | undefined,
  botId: string
): Promise<SourceRef[] | null> => {
  if (sources == null) return null;

  const sourceIds = [
    ...new Set(sources.map((source) => source.source_id).filter((id): id is string => Boolean(id))),
  ];

  const rows = sourceIds.length
    ? await prisma.knowledgeSource.findMany({
        where: { id: { in: sourceIds }, botId },
        select: { id: true, filename: true },
      })
    : [];
  const filenameById = new Map(rows.map((row) => [row.id, row.filename]));

  return sources.map((source) => ({
    chunkId: source.chunk_id,
    sourceId: source.source_id,
    topic: source.topic,
    pageNumber: source.page_number,
    label: source.source_id ? filenameById.get(source.source_id) ?? null : 'FAQ entry',
  }));
};