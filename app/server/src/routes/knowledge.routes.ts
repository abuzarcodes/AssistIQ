import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { documentUpload, uploadLimits } from '../middleware/uploadLimits.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { botIdParamSchema } from '../schemas/bot.schema.js';
import {
  createKnowledgeSchema,
  updateKnowledgeSchema,
  knowledgeIdParamSchema,
} from '../schemas/knowledge.schema.js';
import * as knowledgeController from '../controllers/knowledge.controller.js';

const botScope = { from: 'bot' } as const;
const knowledgeScope = { from: 'knowledge' } as const;

/**
 * Nested under /bots/:botId/knowledge (mergeParams exposes :botId). Mounted by
 * bot.routes.ts, which already sits behind authentication. The workspace is resolved
 * through the bot.
 */
export const knowledgeCreateListRouter = Router({ mergeParams: true });

knowledgeCreateListRouter.post(
  '/',
  validate({ params: botIdParamSchema, body: createKnowledgeSchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_MANAGE, botScope),
  knowledgeController.createKnowledge
);
knowledgeCreateListRouter.get(
  '/',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_VIEW, botScope),
  knowledgeController.listKnowledge
);
knowledgeCreateListRouter.delete(
  '/',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_MANAGE, botScope),
  knowledgeController.deleteAllKnowledge
);
/**
 * Legacy single-file document upload.
 *
 * Kept at this URL with its original contract — one file in the `file` field, a 201 on
 * success — so existing clients keep working. What changed in Checkpoint 4 is the order of
 * the middle two steps and where the size limit comes from:
 *
 *  - The permission guard now runs **before** multer. It previously ran after, so an
 *    unauthorized request had its whole body buffered into memory before being refused
 *    (section 3.4, gap 10).
 *  - The size limit is the platform's resolved `maxUploadFileSizeBytes`, not the 10 MB
 *    literal this route used to carry. The route now enforces the same limit as the batch
 *    route and the 413 message quotes the value that was actually applied (section 12.11).
 *
 * Behaviour is otherwise unchanged: a file larger than the configured limit is still a
 * 413, because a single-file request has no siblings whose work a failure would discard —
 * unlike the batch route, where an oversized file is a per-file `REJECTED`.
 */
knowledgeCreateListRouter.post(
  '/upload-document',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.DOCUMENTS_MANAGE, botScope),
  uploadLimits(),
  documentUpload('file', 'single'),
  knowledgeController.uploadDocument
);

// Top-level /knowledge/:knowledgeId operations.
const router = Router();

router.patch(
  '/:knowledgeId',
  validate({ params: knowledgeIdParamSchema, body: updateKnowledgeSchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_MANAGE, knowledgeScope),
  knowledgeController.updateKnowledge
);
router.delete(
  '/:knowledgeId',
  validate({ params: knowledgeIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.KNOWLEDGE_MANAGE, knowledgeScope),
  knowledgeController.deleteKnowledge
);

export default router;
