import type { Request, RequestHandler } from 'express';
import { getAuthUser } from './auth.middleware.js';
import { ForbiddenError, NotFoundError } from '../utils/errors.js';
import { hasPermission, type Permission } from '../constants/permissions.js';
import prisma from '../config/database.js';
import * as authorizationService from '../services/authorization.service.js';

/**
 * RBAC enforcement middleware (Checkpoint 3).
 *
 * Two domains, evaluated independently:
 *   - `requirePlatformOwner()`      — global platform routes (`/platform/*`, `/admin/ai/*`)
 *   - `requireWorkspacePermission()` — workspace-scoped routes
 *
 * Denial semantics (important):
 *   - No workspace membership → **404**, not 403. A tenant the caller cannot see must be
 *     indistinguishable from one that does not exist (preserves the pre-RBAC isolation
 *     guarantee).
 *   - Member but role lacks the permission → **403**.
 *
 * Async middleware must forward rejections manually: Express 4 does not await handlers, so
 * each factory wraps its body in try/catch and calls `next(err)`.
 */

/**
 * Where to read the workspace id from.
 *   'params'          — `req.params.workspaceId` (default)
 *   'bot'             — resolve via Bot → workspaceId
 *   'knowledge'       — resolve via KnowledgeEntry → bot → workspaceId
 *   'knowledgeSource' — resolve via KnowledgeSource → bot → workspaceId
 *   'knowledgeChunk'  — resolve via KnowledgeChunk → bot → workspaceId
 *   'conversation'    — resolve via Conversation → bot → workspaceId
 */
export type WorkspaceScope =
  | { from: 'params'; param?: string }
  | { from: 'bot'; param?: string }
  | { from: 'knowledge'; param?: string }
  | { from: 'knowledgeSource'; param?: string }
  | { from: 'knowledgeChunk'; param?: string }
  | { from: 'conversation'; param?: string };

/** Resolve the workspace id for the request, or throw 404 when the resource is absent. */
const resolveWorkspaceId = async (req: Request, scope: WorkspaceScope): Promise<string> => {
  switch (scope.from) {
    case 'params': {
      const workspaceId = req.params[scope.param ?? 'workspaceId'];
      if (!workspaceId) {
        throw new NotFoundError('Workspace not found');
      }
      return workspaceId;
    }

    case 'bot': {
      const bot = await prisma.bot.findUnique({
        where: { id: req.params[scope.param ?? 'botId'] ?? '' },
        select: { workspaceId: true },
      });
      if (!bot) {
        throw new NotFoundError('Bot not found');
      }
      return bot.workspaceId;
    }

    case 'knowledge': {
      const entry = await prisma.knowledgeEntry.findUnique({
        where: { id: req.params[scope.param ?? 'knowledgeId'] ?? '' },
        select: { bot: { select: { workspaceId: true } } },
      });
      if (!entry) {
        throw new NotFoundError('Knowledge entry not found');
      }
      return entry.bot.workspaceId;
    }

    case 'knowledgeSource': {
      const source = await prisma.knowledgeSource.findUnique({
        where: { id: req.params[scope.param ?? 'sourceId'] ?? '' },
        select: { bot: { select: { workspaceId: true } } },
      });
      if (!source) {
        throw new NotFoundError('Knowledge source not found');
      }
      return source.bot.workspaceId;
    }

    case 'knowledgeChunk': {
      const chunk = await prisma.knowledgeChunk.findUnique({
        where: { id: req.params[scope.param ?? 'chunkId'] ?? '' },
        select: { bot: { select: { workspaceId: true } } },
      });
      if (!chunk) {
        throw new NotFoundError('Knowledge chunk not found');
      }
      return chunk.bot.workspaceId;
    }

    case 'conversation': {
      const conversation = await prisma.conversation.findUnique({
        where: { id: req.params[scope.param ?? 'conversationId'] ?? '' },
        select: { bot: { select: { workspaceId: true } } },
      });
      if (!conversation) {
        throw new NotFoundError('Conversation not found');
      }
      return conversation.bot.workspaceId;
    }
  }
};

/**
 * Gate a route to PLATFORM_OWNERs. The role is re-read from the database (`isPlatformOwner`),
 * so a demotion applies immediately rather than at token expiry.
 */
export const requirePlatformOwner = (): RequestHandler => async (req, _res, next) => {
  try {
    const user = getAuthUser(req);

    if (!(await authorizationService.isPlatformOwner(user.id))) {
      throw new ForbiddenError('Platform owner access required');
    }

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Gate a workspace-scoped route on a permission.
 *
 * On success the resolved context is attached as `req.workspaceContext` so downstream
 * controllers/services can scope queries to the workspace without re-resolving it.
 */
export const requireWorkspacePermission = (
  permission: Permission,
  scope: WorkspaceScope = { from: 'params' }
): RequestHandler => async (req, _res, next) => {
  try {
    const user = getAuthUser(req);
    const workspaceId = await resolveWorkspaceId(req, scope);

    const membership = await authorizationService.getWorkspaceMembership(user.id, workspaceId);
    if (!membership) {
      // Not a member: mirror "not found" so we never confirm the tenant exists.
      throw new NotFoundError('Workspace not found');
    }

    if (!hasPermission(membership.role, permission)) {
      throw new ForbiddenError();
    }

    req.workspaceContext = { workspaceId, membership };
    next();
  } catch (err) {
    next(err);
  }
};
