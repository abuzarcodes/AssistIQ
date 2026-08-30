import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import workspaceRoutes from './workspace.routes.js';
import botRoutes from './bot.routes.js';
import knowledgeRoutes from './knowledge.routes.js';
import conversationRoutes from './conversation.routes.js';

const router = Router();

// Public authentication endpoints (self-rate-limited).
router.use('/auth', authRoutes);

// Protected namespaces — `authenticate` runs once here and covers nested routers
// (e.g. /workspaces/:workspaceId/bots, /bots/:botId/conversations).
router.use('/users', authenticate, userRoutes);
router.use('/workspaces', authenticate, workspaceRoutes);
router.use('/bots', authenticate, botRoutes);
router.use('/knowledge', authenticate, knowledgeRoutes);
router.use('/conversations', authenticate, conversationRoutes);

export default router;
