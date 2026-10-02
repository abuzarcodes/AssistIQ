import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { workspaceIdParamSchema } from '../schemas/workspace.schema.js';
import { createBotSchema, updateBotSchema, botIdParamSchema, assignModelSchema } from '../schemas/bot.schema.js';
import * as botController from '../controllers/bot.controller.js';
import { knowledgeCreateListRouter } from './knowledge.routes.js';
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

router.use('/:botId/knowledge', knowledgeCreateListRouter);
router.use('/:botId/conversations', conversationCreateListRouter);

export default router;
