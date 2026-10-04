import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { workspaceIdParamSchema } from '../schemas/workspace.schema.js';
import { createBotSchema, updateBotSchema, botIdParamSchema, assignModelSchema } from '../schemas/bot.schema.js';
import {
  updateBotConfigSchema,
  resetBotConfigSchema,
  previewConfigSchema,
} from '../schemas/botConfig.schema.js';
import { avatarUpload } from '../middleware/uploadLimits.middleware.js';
import * as botController from '../controllers/bot.controller.js';
import * as botConfigController from '../controllers/botConfig.controller.js';
import { knowledgeCreateListRouter } from './knowledge.routes.js';
import { knowledgeSourceCreateListRouter } from './knowledgeSource.routes.js';
import { knowledgeChunkCreateListRouter, knowledgeTestRouter } from './knowledgeChunk.routes.js';
import { conversationCreateListRouter } from './conversation.routes.js';

/**
 * Nested under /workspaces/:workspaceId/bots (mergeParams exposes :workspaceId).
 * Mounted by workspace.routes.ts, which already sits behind authentication. The workspace
 * id comes straight from the path, so the permission middleware uses the default 'params'
 * scope.
 */
export const botCreateListRouter = Router({ mergeParams: true });

botCreateListRouter.post(
  '/',
  validate({ params: workspaceIdParamSchema, body: createBotSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE),
  botController.createBot
);
botCreateListRouter.get(
  '/',
  validate({ params: workspaceIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_VIEW),
  botController.listBots
);

// Top-level /bots/:botId operations + nested knowledge/conversation resources. These routes
// carry no workspace id, so the middleware resolves the workspace through the bot.
const router = Router();

const botScope = { from: 'bot' } as const;

router.get(
  '/:botId',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_VIEW, botScope),
  botController.getBot
);
router.patch(
  '/:botId',
  validate({ params: botIdParamSchema, body: updateBotSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  botController.updateBot
);
router.delete(
  '/:botId',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  botController.deleteBot
);

// Assigning a model is a bot-management action, so it reuses `bots:manage` rather than
// introducing a permission (AGENT holds neither, and must not gain one). The model id is
// validated as an internal uuid by `assignModelSchema`, so a provider-native id — the
// catalog-bypass attempt — is a 400 before any handler runs.
router.patch(
  '/:botId/model',
  validate({ params: botIdParamSchema, body: assignModelSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  botController.assignModel
);

// ---------------------------------------------------------------------------------------
// Configuration (§10.1). Reading the configuration is `bots:view` and every write is
// `bots:manage`, so the configuration surface is OWNER/ADMIN throughout. No new permission
// string is introduced: `bots:view` / `bots:manage` already draw exactly the line the plan
// draws, and an AGENT holds neither (plan §10.4) — the conversationalist role works from
// conversations, not from how the bot is configured.
// ---------------------------------------------------------------------------------------

router.get(
  '/:botId/config',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_VIEW, botScope),
  botConfigController.getConfig
);
router.patch(
  '/:botId/config',
  validate({ params: botIdParamSchema, body: updateBotConfigSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  botConfigController.updateConfig
);
router.post(
  '/:botId/config/reset',
  validate({ params: botIdParamSchema, body: resetBotConfigSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  botConfigController.resetConfig
);

// The preview is a **real** provider call, so it is gated on `bots:manage` (not
// `bots:view`) — an AGENT cannot use it as free inference, and nothing it does is persisted
// (§17.2). It deliberately does not reuse the AI Lab's pipeline-debug endpoint, which would
// hand an owner retrieval scores and the full debug trace: that is the deferred Tier 3
// retrieval debugger.
router.post(
  '/:botId/config/preview',
  validate({ params: botIdParamSchema, body: previewConfigSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  botConfigController.previewConfig
);

// ---------------------------------------------------------------------------------------
// Avatar (§10.2).
//
// **The permission guard is listed before `avatarUpload` on purpose.** Multer buffers the
// whole body into memory as it parses, so a guard placed after it would let an unauthorized
// caller make the server allocate before being refused — the memory-amplification reasoning
// documented at the top of `uploadLimits.middleware.ts`. The parser's own `fileSize` cap
// bounds the damage; it does not make the ordering optional.
//
// No `uploadLimits()` middleware runs here: the avatar ceiling is a product constant, not a
// per-workspace operator setting (see `constants/uploads.ts`).
// ---------------------------------------------------------------------------------------

router.post(
  '/:botId/avatar',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  avatarUpload('avatar'),
  botConfigController.uploadAvatar
);
router.delete(
  '/:botId/avatar',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_MANAGE, botScope),
  botConfigController.deleteAvatar
);
router.get(
  '/:botId/avatar',
  validate({ params: botIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.BOTS_VIEW, botScope),
  botConfigController.getAvatar
);

router.use('/:botId/knowledge', knowledgeCreateListRouter);
// Document sources are a separate collection from FAQ entries (`knowledge`), with their
// own permissions (`documents:*`) and their own lifecycle, so they get their own path.
router.use('/:botId/knowledge-sources', knowledgeSourceCreateListRouter);
// Chunks are listed per bot but read and mutated by their own id — see
// knowledgeChunk.routes.ts for why those live on two routers.
router.use('/:botId/knowledge-chunks', knowledgeChunkCreateListRouter);
// Retrieval testing spans the whole knowledge base, so it is a sibling of the collections
// rather than a member of either.
router.use('/:botId/knowledge-test', knowledgeTestRouter);
router.use('/:botId/conversations', conversationCreateListRouter);

export default router;
