import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { botIdParamSchema } from '../schemas/bot.schema.js';
import {
  bulkChunkOperationSchema,
  chunkIdParamSchema,
  knowledgeTestSchema,
  listChunksQuerySchema,
  updateChunkSchema,
} from '../schemas/knowledgeChunk.schema.js';
import * as knowledgeChunkController from '../controllers/knowledgeChunk.controller.js';

/**
 * Chunk routes (section 11.2).
 *
 * Split across two routers because the collection and the item resolve their workspace
 * differently: the collection routes carry `:botId` and resolve through the bot, while the
 * item routes carry only a chunk id and resolve through the chunk's own bot. The same
 * split the source routes use, for the same reason — the permission scope has to be
 * resolvable from the path alone.
 */

/**
 * Nested under /bots/:botId/knowledge-chunks (mergeParams exposes :botId). Mounted by
 * bot.routes.ts, which already sits behind authentication.
 *
 * `/bulk` and `/stats` are registered here, on the bot-scoped router, rather than at the
 * top level. Both are collection operations — they act on "this bot's chunks" — and
 * putting them here means the literal segments never sit in the same router as
 * `/:chunkId`, where declaration order alone would decide whether "bulk" was a verb or a
 * chunk id.
 */
export const knowledgeChunkCreateListRouter = Router({ mergeParams: true });

const botScope = { from: 'bot' } as const;

knowledgeChunkCreateListRouter.get(
  '/',
  validate({ params: botIdParamSchema, query: listChunksQuerySchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_VIEW, botScope),
  knowledgeChunkController.listChunks
);

knowledgeChunkCreateListRouter.get(
  '/stats',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_VIEW, botScope),
  knowledgeChunkController.getStats
);

knowledgeChunkCreateListRouter.post(
  '/bulk',
  validate({ params: botIdParamSchema, body: bulkChunkOperationSchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_MANAGE, botScope),
  knowledgeChunkController.bulkChunks
);

/**
 * Retrieval testing (section 11.3).
 *
 * A sibling of the chunk collection rather than a member of it: the search runs against
 * the bot's whole knowledge base — documents *and* FAQ entries — so scoping it under
 * `/knowledge-chunks` would promise narrower reach than it has. It needs no new
 * permission: reading knowledge is what it does, so `KNOWLEDGE_VIEW` is the gate, and an
 * AGENT who can see the knowledge can try it.
 */
export const knowledgeTestRouter = Router({ mergeParams: true });

knowledgeTestRouter.post(
  '/',
  validate({ params: botIdParamSchema, body: knowledgeTestSchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_VIEW, botScope),
  knowledgeChunkController.testRetrieval
);

// Top-level /knowledge-chunks/:chunkId operations.
const router = Router();
const chunkScope = { from: 'knowledgeChunk' } as const;

router.get(
  '/:chunkId',
  validate({ params: chunkIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_VIEW, chunkScope),
  knowledgeChunkController.getChunk
);
router.patch(
  '/:chunkId',
  validate({ params: chunkIdParamSchema, body: updateChunkSchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_MANAGE, chunkScope),
  knowledgeChunkController.updateChunk
);
router.delete(
  '/:chunkId',
  validate({ params: chunkIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_MANAGE, chunkScope),
  knowledgeChunkController.deleteChunk
);

export default router;
