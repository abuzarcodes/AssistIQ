import { Router } from 'express';
import multer from 'multer';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { botIdParamSchema } from '../schemas/bot.schema.js';
import {
  createKnowledgeSchema,
  updateKnowledgeSchema,
  knowledgeIdParamSchema,
} from '../schemas/knowledge.schema.js';
import * as knowledgeController from '../controllers/knowledge.controller.js';
import { AppError } from '../utils/errors.js';

// Multer config: memory storage, 10 MB limit, PDF/DOCX only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      // A wrong content type is a client error, so surface it as 400 (not a 500).
      cb(new AppError('Only PDF and DOCX files are allowed.', 400));
    }
  },
});

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
knowledgeCreateListRouter.post(
  '/upload-document',
  upload.single('file'),
  // Document upload is guarded before multer buffers the body into memory.
  requireWorkspacePermission(PERMISSIONS.DOCUMENTS_MANAGE, botScope),
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
