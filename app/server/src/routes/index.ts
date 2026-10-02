import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { requirePlatformOwner } from '../middleware/authorization.middleware.js';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import workspaceRoutes from './workspace.routes.js';
import botRoutes from './bot.routes.js';
import knowledgeRoutes from './knowledge.routes.js';
import conversationRoutes from './conversation.routes.js';
import adminAiRoutes from './admin.ai.routes.js';
import platformRoutes from './platform.routes.js';
import aiCatalogRoutes from './aiCatalog.routes.js';

const router = Router();

// Public authentication endpoints (self-rate-limited).
router.use('/auth', authRoutes);

// Protected namespaces — `authenticate` runs once here and covers nested routers
// (e.g. /workspaces/:workspaceId/bots, /bots/:botId/conversations). Fine-grained RBAC is
// applied per-route inside each router, where the resource scope is known.
router.use('/users', authenticate, userRoutes);
router.use('/workspaces', authenticate, workspaceRoutes);
router.use('/bots', authenticate, botRoutes);
router.use('/knowledge', authenticate, knowledgeRoutes);
router.use('/conversations', authenticate, conversationRoutes);

// The AI catalog as workspaces see it: the list of *enabled* models, so a client can offer
// a model selector. Authenticated but deliberately unscoped — the list is identical for
// every caller and contains no tenant data, and this router carries no workspace id for a
// permission check to resolve. Authorization lives on the write path instead
// (`PATCH /bots/:botId/model`, gated on `bots:manage`).
router.use('/ai', authenticate, aiCatalogRoutes);

// AI Lab / testing tools: authenticated AND platform-owner only. Previously any
// authenticated user could reach these (see the audit in the RBAC plan).
router.use('/admin/ai', authenticate, requirePlatformOwner(), adminAiRoutes);

// Platform administration: cross-tenant reads, platform-owner only.
router.use('/platform', authenticate, requirePlatformOwner(), platformRoutes);

export default router;
