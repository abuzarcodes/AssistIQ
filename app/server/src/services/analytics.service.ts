import { Prisma, type DeploymentEvent, type DeploymentFormat } from '@prisma/client';
import prisma from '../config/database.js';
import { getBotById } from './bot.service.js';
import { NotFoundError, ForbiddenError } from '../utils/errors.js';
import type { AnalyticsQueryInput } from '../schemas/analytics.schema.js';

export interface DeploymentMetrics {
  pageViews: number;
  chatStarts: number;
  conversationsCreated: number;
  aiResolved: number;
  humanHandoff: number;
  conversationsResolved: number;
}

export interface DeploymentAnalyticsResponse {
  deploymentId: string;
  format: DeploymentFormat;
  period: {
    startDate: string;
    endDate: string;
  };
  metrics: DeploymentMetrics;
}

export interface DeploymentSummaryMetrics {
  deploymentId: string;
  format: DeploymentFormat;
  botId: string;
  metrics: DeploymentMetrics;
}

export interface WorkspaceAnalyticsResponse {
  workspaceId: string;
  period: {
    startDate: string;
    endDate: string;
  };
  deployments: DeploymentSummaryMetrics[];
  totals: DeploymentMetrics;
}

const emptyMetrics = (): DeploymentMetrics => ({
  pageViews: 0,
  chatStarts: 0,
  conversationsCreated: 0,
  aiResolved: 0,
  humanHandoff: 0,
  conversationsResolved: 0,
});

const parseDateRange = (query?: AnalyticsQueryInput): { start: Date; end: Date } => {
  const end = query?.endDate ? new Date(query.endDate) : new Date();
  let start: Date;
  if (query?.startDate) {
    start = new Date(query.startDate);
  } else {
    start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000); // default last 30 days
  }
  return { start, end };
};

/**
 * Record a deployment analytics event (CP-5.1, CP-5.8).
 * Deduplicates page_view events by sessionId within a 30-minute window.
 */
export const recordEvent = async (
  deploymentId: string,
  eventType: string,
  sessionId?: string | null,
  metadata?: Record<string, any> | null
): Promise<DeploymentEvent | null> => {
  const deployment = await prisma.botDeployment.findUnique({
    where: { id: deploymentId },
    select: { botId: true, workspaceId: true, status: true, enabled: true },
  });

  if (!deployment) {
    return null;
  }

  // CP-5.8: Event deduplication: page_view events with same sessionId within 30 min are counted once
  if (eventType === 'page_view' && sessionId) {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recent = await prisma.deploymentEvent.findFirst({
      where: {
        deploymentId,
        eventType: 'page_view',
        sessionId,
        createdAt: { gte: thirtyMinutesAgo },
      },
    });

    if (recent) {
      return recent;
    }
  }

  return prisma.deploymentEvent.create({
    data: {
      deploymentId,
      botId: deployment.botId,
      workspaceId: deployment.workspaceId,
      eventType,
      sessionId: sessionId || null,
      metadata: metadata ? (metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
  });
};

/**
 * Aggregate analytics metrics for a specific deployment (CP-5.5).
 */
export const getDeploymentAnalytics = async (
  deploymentId: string,
  userId: string,
  query?: AnalyticsQueryInput
): Promise<DeploymentAnalyticsResponse> => {
  const deployment = await prisma.botDeployment.findUnique({
    where: { id: deploymentId },
    select: { id: true, botId: true, format: true },
  });

  if (!deployment) {
    throw new NotFoundError('Deployment not found');
  }

  await getBotById(deployment.botId, userId);

  const { start, end } = parseDateRange(query);

  const grouped = await prisma.deploymentEvent.groupBy({
    by: ['eventType'],
    where: {
      deploymentId,
      createdAt: {
        gte: start,
        lte: end,
      },
    },
    _count: {
      _all: true,
    },
  });

  const metrics = emptyMetrics();

  for (const item of grouped) {
    const count = item._count._all;
    switch (item.eventType) {
      case 'page_view':
        metrics.pageViews = count;
        break;
      case 'chat_start':
        metrics.chatStarts = count;
        break;
      case 'conversation_created':
        metrics.conversationsCreated = count;
        break;
      case 'ai_resolved':
        metrics.aiResolved = count;
        break;
      case 'human_handoff':
        metrics.humanHandoff = count;
        break;
      case 'conversation_resolved':
        metrics.conversationsResolved = count;
        break;
    }
  }

  return {
    deploymentId,
    format: deployment.format,
    period: {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    },
    metrics,
  };
};

/**
 * Aggregate workspace-wide analytics with per-deployment breakdown (CP-5.6).
 */
export const getWorkspaceAnalytics = async (
  workspaceId: string,
  userId: string,
  query?: AnalyticsQueryInput
): Promise<WorkspaceAnalyticsResponse> => {
  const member = await prisma.workspaceMember.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
  });

  if (!member) {
    throw new NotFoundError('Workspace not found');
  }

  const { start, end } = parseDateRange(query);

  const deployments = await prisma.botDeployment.findMany({
    where: { workspaceId },
    select: { id: true, format: true, botId: true },
    orderBy: { createdAt: 'asc' },
  });

  const grouped = await prisma.deploymentEvent.groupBy({
    by: ['deploymentId', 'eventType'],
    where: {
      workspaceId,
      createdAt: {
        gte: start,
        lte: end,
      },
    },
    _count: {
      _all: true,
    },
  });

  const totals = emptyMetrics();
  const deploymentMap = new Map<string, DeploymentMetrics>();

  for (const d of deployments) {
    deploymentMap.set(d.id, emptyMetrics());
  }

  for (const row of grouped) {
    const dMetrics = deploymentMap.get(row.deploymentId) || emptyMetrics();
    const count = row._count._all;

    switch (row.eventType) {
      case 'page_view':
        dMetrics.pageViews += count;
        totals.pageViews += count;
        break;
      case 'chat_start':
        dMetrics.chatStarts += count;
        totals.chatStarts += count;
        break;
      case 'conversation_created':
        dMetrics.conversationsCreated += count;
        totals.conversationsCreated += count;
        break;
      case 'ai_resolved':
        dMetrics.aiResolved += count;
        totals.aiResolved += count;
        break;
      case 'human_handoff':
        dMetrics.humanHandoff += count;
        totals.humanHandoff += count;
        break;
      case 'conversation_resolved':
        dMetrics.conversationsResolved += count;
        totals.conversationsResolved += count;
        break;
    }
    deploymentMap.set(row.deploymentId, dMetrics);
  }

  const deploymentSummaries: DeploymentSummaryMetrics[] = deployments.map((d) => ({
    deploymentId: d.id,
    format: d.format,
    botId: d.botId,
    metrics: deploymentMap.get(d.id) || emptyMetrics(),
  }));

  return {
    workspaceId,
    period: {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    },
    deployments: deploymentSummaries,
    totals,
  };
};
