import prisma from '../config/database.js';
import { userSafeSelect } from './user.service.js';
import { aiServiceClient } from './aiServiceClient.js';
import { logger } from '../config/logger.js';

/**
 * Platform administration data access (Checkpoint 4).
 *
 * These are global, cross-tenant reads — deliberately NOT scoped by membership. They are
 * only reachable through `requirePlatformOwner()`, so a workspace role can never call them.
 */

/** Every user on the platform, without password hashes. */
export const listUsers = () =>
  prisma.user.findMany({
    select: userSafeSelect,
    orderBy: { createdAt: 'desc' },
  });

/** Every workspace on the platform, with light owner and size context. */
export const listWorkspaces = () =>
  prisma.workspace.findMany({
    select: {
      id: true,
      name: true,
      ownerId: true,
      createdAt: true,
      updatedAt: true,
      owner: { select: { id: true, name: true, email: true } },
      _count: { select: { bots: true, members: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

export interface SystemStatus {
  service: string;
  database: { reachable: boolean };
  aiService: { reachable: boolean; detail?: unknown; error?: string };
  counts: { users: number; workspaces: number; bots: number; conversations: number };
}

/**
 * Platform system status: local database reachability plus a proxied AI-service health
 * probe.
 *
 * A down AI service is reported as `aiService.reachable = false` rather than failing the
 * whole request — the platform dashboard should still render when only the AI service is
 * unavailable.
 */
export const getSystemStatus = async (): Promise<SystemStatus> => {
  const [users, workspaces, bots, conversations] = await Promise.all([
    prisma.user.count(),
    prisma.workspace.count(),
    prisma.bot.count(),
    prisma.conversation.count(),
  ]);

  let aiService: SystemStatus['aiService'];
  try {
    const detail = await aiServiceClient.getSystemStatus();
    aiService = { reachable: true, detail };
  } catch (err) {
    logger.warn({ err }, 'AI service unreachable during platform system status check');
    aiService = { reachable: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }

  return {
    service: 'assistiq-backend',
    database: { reachable: true },
    aiService,
    counts: { users, workspaces, bots, conversations },
  };
};
