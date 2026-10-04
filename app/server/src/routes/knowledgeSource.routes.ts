import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { documentUpload, uploadLimits } from '../middleware/uploadLimits.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { botIdParamSchema } from '../schemas/bot.schema.js';
import {
  listSourcesQuerySchema,
  sourceIdParamSchema,
} from '../schemas/knowledgeSource.schema.js';
import * as knowledgeSourceController from '../controllers/knowledgeSource.controller.js';

/**
 * Nested under /bots/:botId/knowledge-sources (mergeParams exposes :botId). Mounted by
 * bot.routes.ts, which already sits behind authentication.
 *
 * The handler order on the upload route is the security-relevant part of this file, and
 * every step is required before the next:
 *
 * ```
 * requireWorkspacePermission(DOCUMENTS_MANAGE)  ← resolves the workspace, rejects non-members
 *   → uploadLimits()                            ← resolves the operator's limits onto the request
 *   → documentUpload('files', 'batch')          ← multer, built from those limits
 *   → uploadSources                             ← the handler
 * ```
 *
 * **Why the guard is first.** Multer buffers the whole body into memory as it parses, so a
 * guard placed after it would let an unauthorized caller make the server allocate every
 * file in the request before being refused (section 3.4, gap 10). For a batch of ten 10 MB
 * files that is 100 MB of heap per unauthorized request.
 *
 * **Why multer cannot be a module-level instance.** `limits.fileSize` and the file count
 * are fixed when the instance is constructed, and both are runtime settings now — a
 * module-level parser could only enforce a constant, which is the duplicated-literal
 * problem this checkpoint exists to fix (section 12.5).
 */
export const knowledgeSourceCreateListRouter = Router({ mergeParams: true });

const botScope = { from: 'bot' } as const;

knowledgeSourceCreateListRouter.post(
  '/upload',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.DOCUMENTS_MANAGE, botScope),
  uploadLimits(),
  documentUpload('files', 'batch'),
  knowledgeSourceController.uploadSources
);

knowledgeSourceCreateListRouter.get(
  '/',
  validate({ params: botIdParamSchema, query: listSourcesQuerySchema }),
  requireWorkspacePermission(PERMISSIONS.DOCUMENTS_VIEW, botScope),
  knowledgeSourceController.listSources
);

/**
 * The limits the client uses for its pre-flight checks.
 *
 * `DOCUMENTS_VIEW` rather than `DOCUMENTS_MANAGE`: the values are what the upload UI needs
 * to render, and an AGENT who can read the source list is exactly the caller that renders
 * that UI. The values are not secret — they are the platform's advertised configuration.
 *
 * Registered against the nested router, so the workspace is resolved through the bot and
 * a non-member gets the same 404 as for any other route here.
 */
knowledgeSourceCreateListRouter.get(
  '/upload-limits',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.DOCUMENTS_VIEW, botScope),
  uploadLimits(),
  knowledgeSourceController.getUploadLimits
);

// Top-level /knowledge-sources/:sourceId operations.
const router = Router();
const sourceScope = { from: 'knowledgeSource' } as const;

router.get(
  '/:sourceId',
  validate({ params: sourceIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.DOCUMENTS_VIEW, sourceScope),
  knowledgeSourceController.getSource
);
router.delete(
  '/:sourceId',
  validate({ params: sourceIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.DOCUMENTS_MANAGE, sourceScope),
  knowledgeSourceController.deleteSource
);

export default router;
