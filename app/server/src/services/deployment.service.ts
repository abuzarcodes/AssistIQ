import type { DeploymentFormat, DeploymentStatus } from '@prisma/client';
import prisma from '../config/database.js';
import { getBotById } from './bot.service.js';
import { NotFoundError, AppError, ValidationError } from '../utils/errors.js';
import type { ExperienceConfigSnapshot } from '../types/experience.types.js';
import {
  isValidDomain,
  isValidSlug,
  type UpdateDeploymentInput,
} from '../schemas/deployment.schema.js';

export interface PublishedDeploymentPayload {
  deployment: {
    id: string;
    botId: string;
    workspaceId: string;
    format: DeploymentFormat;
    status: DeploymentStatus;
    slug: string | null;
    publishEpoch: number;
    allowedDomains: string[];
  };
  bot: {
    id: string;
    name: string;
  };
  config: ExperienceConfigSnapshot;
}

export interface DeploymentDomainDTO {
  id: string;
  deploymentId: string;
  domain: string;
  createdAt: string;
}

export interface DeploymentDetailDTO {
  id: string;
  experienceId: string;
  botId: string;
  workspaceId: string;
  format: DeploymentFormat;
  status: DeploymentStatus;
  slug: string | null;
  enabled: boolean;
  unpublishedAt: string | null;
  publishEpoch: number;
  domains: DeploymentDomainDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentSnippetResponse {
  deploymentId: string;
  format: DeploymentFormat;
  snippet: string;
  url: string;
}

const formatDeploymentDetailDTO = (deployment: any): DeploymentDetailDTO => ({
  id: deployment.id,
  experienceId: deployment.experienceId,
  botId: deployment.botId,
  workspaceId: deployment.workspaceId,
  format: deployment.format,
  status: deployment.status,
  slug: deployment.slug,
  enabled: deployment.enabled,
  unpublishedAt: deployment.unpublishedAt ? deployment.unpublishedAt.toISOString() : null,
  publishEpoch: deployment.publishEpoch,
  domains: (deployment.domains || []).map((d: any) => ({
    id: d.id,
    deploymentId: d.deploymentId || deployment.id,
    domain: d.domain,
    createdAt: d.createdAt.toISOString(),
  })),
  createdAt: deployment.createdAt.toISOString(),
  updatedAt: deployment.updatedAt.toISOString(),
});

/**
 * Fetch published experience configuration for a deployment (CP-3.1, CP-4.8).
 * Returns null if deployment does not exist, is not PUBLISHED, is disabled,
 * or has no published version snapshot.
 */
export const getPublishedConfig = async (
  deploymentId: string
): Promise<PublishedDeploymentPayload | null> => {
  const deployment = await prisma.botDeployment.findUnique({
    where: { id: deploymentId },
    include: {
      domains: {
        select: { domain: true },
      },
      experience: {
        include: {
          publishedVersion: true,
          bot: {
            select: { id: true, name: true, isActive: true },
          },
        },
      },
    },
  });

  if (
    !deployment ||
    deployment.status !== 'PUBLISHED' ||
    !deployment.enabled ||
    !deployment.experience?.publishedVersion ||
    !deployment.experience?.bot?.isActive
  ) {
    return null;
  }

  return {
    deployment: {
      id: deployment.id,
      botId: deployment.botId,
      workspaceId: deployment.workspaceId,
      format: deployment.format,
      status: deployment.status,
      slug: deployment.slug,
      publishEpoch: deployment.publishEpoch,
      allowedDomains: deployment.domains ? deployment.domains.map((d: { domain: string }) => d.domain) : [],
    },
    bot: {
      id: deployment.experience.bot.id,
      name: deployment.experience.bot.name,
    },
    config: deployment.experience.publishedVersion.config as unknown as ExperienceConfigSnapshot,
  };
};

/**
 * Fetch published experience configuration by deployment slug (CP-3.3, CP-4.8).
 * Used for hosted public chat pages.
 */
export const getPublishedConfigBySlug = async (
  slug: string
): Promise<PublishedDeploymentPayload | null> => {
  const deployment = await prisma.botDeployment.findUnique({
    where: { slug },
    include: {
      domains: {
        select: { domain: true },
      },
      experience: {
        include: {
          publishedVersion: true,
          bot: {
            select: { id: true, name: true, isActive: true },
          },
        },
      },
    },
  });

  if (
    !deployment ||
    deployment.status !== 'PUBLISHED' ||
    !deployment.enabled ||
    !deployment.experience?.publishedVersion ||
    !deployment.experience?.bot?.isActive
  ) {
    return null;
  }

  return {
    deployment: {
      id: deployment.id,
      botId: deployment.botId,
      workspaceId: deployment.workspaceId,
      format: deployment.format,
      status: deployment.status,
      slug: deployment.slug,
      publishEpoch: deployment.publishEpoch,
      allowedDomains: deployment.domains ? deployment.domains.map((d: { domain: string }) => d.domain) : [],
    },
    bot: {
      id: deployment.experience.bot.id,
      name: deployment.experience.bot.name,
    },
    config: deployment.experience.publishedVersion.config as unknown as ExperienceConfigSnapshot,
  };
};

/**
 * List all deployments for a bot (CP-4.1).
 * Returns status, format, slug, enabled state, and configured domains.
 */
export const listDeployments = async (
  botId: string,
  userId: string
): Promise<DeploymentDetailDTO[]> => {
  await getBotById(botId, userId);

  const deployments = await prisma.botDeployment.findMany({
    where: { botId },
    include: {
      domains: {
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return deployments.map(formatDeploymentDetailDTO);
};

/**
 * Update deployment-specific settings with optimistic concurrency (CP-4.2, CP-4.10).
 */
export const updateDeployment = async (
  deploymentId: string,
  userId: string,
  data: UpdateDeploymentInput
): Promise<DeploymentDetailDTO> => {
  const deployment = await prisma.botDeployment.findUnique({
    where: { id: deploymentId },
    include: {
      experience: {
        select: { version: true },
      },
      domains: true,
    },
  });

  if (!deployment) {
    throw new NotFoundError('Deployment not found');
  }

  await getBotById(deployment.botId, userId);

  if (
    data.expectedVersion !== undefined &&
    deployment.experience.version !== data.expectedVersion
  ) {
    throw new AppError(
      'This deployment was modified by another session. Reload to see the latest settings.',
      409,
      true,
      formatDeploymentDetailDTO(deployment)
    );
  }

  if (data.slug !== undefined) {
    if (deployment.format !== 'HOSTED_PAGE') {
      throw new ValidationError('Slug customization is only available for hosted page deployments.');
    }

    if (!isValidSlug(data.slug)) {
      throw new ValidationError(
        'Invalid slug format. Slugs must be 3-80 lowercase alphanumeric characters with single hyphens.'
      );
    }

    const existingSlug = await prisma.botDeployment.findFirst({
      where: {
        slug: data.slug,
        id: { not: deploymentId },
      },
    });

    if (existingSlug) {
      throw new AppError('This slug is already in use by another deployment.', 409);
    }
  }

  const updated = await prisma.botDeployment.update({
    where: { id: deploymentId },
    data: {
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.slug !== undefined ? { slug: data.slug } : {}),
    },
    include: {
      domains: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  return formatDeploymentDetailDTO(updated);
};

const getBaseUrl = (): string => {
  const envUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (envUrl && envUrl.trim().length > 0) {
    return envUrl.trim().replace(/\/+$/, '');
  }
  return 'http://localhost:3000';
};

/**
 * Generate format-specific installation snippet (CP-4.3, CP-4.4, CP-4.5, CP-4.6).
 */
export const getDeploymentSnippet = async (
  deploymentId: string,
  userId: string
): Promise<DeploymentSnippetResponse> => {
  const deployment = await prisma.botDeployment.findUnique({
    where: { id: deploymentId },
    include: {
      experience: true,
    },
  });

  if (!deployment) {
    throw new NotFoundError('Deployment not found');
  }

  await getBotById(deployment.botId, userId);

  const baseUrl = getBaseUrl();

  let snippet = '';
  let url = '';

  switch (deployment.format) {
    case 'WIDGET': {
      url = `${baseUrl}/widget/loader.js`;
      snippet = `<script src="${baseUrl}/widget/loader.js" data-deployment-id="${deployment.id}" async defer></script>`;
      break;
    }

    case 'IFRAME': {
      url = `${baseUrl}/chat/embed/${deployment.id}`;
      const width = deployment.experience?.iframeWidth || '100%';
      const height = deployment.experience?.iframeHeight || '600px';
      snippet = `<iframe src="${baseUrl}/chat/embed/${deployment.id}" width="${width}" height="${height}" frameborder="0" allow="clipboard-write"></iframe>`;
      break;
    }

    case 'HOSTED_PAGE':
    default: {
      const slugOrId = deployment.slug || deployment.id;
      url = `${baseUrl}/chat/${slugOrId}`;
      snippet = `${baseUrl}/chat/${slugOrId}`;
      break;
    }
  }

  return {
    deploymentId: deployment.id,
    format: deployment.format,
    snippet,
    url,
  };
};

/**
 * List allowed domains for a deployment (CP-4.7).
 */
export const listDomains = async (
  deploymentId: string,
  userId: string
): Promise<DeploymentDomainDTO[]> => {
  const deployment = await prisma.botDeployment.findUnique({
    where: { id: deploymentId },
    select: { botId: true },
  });

  if (!deployment) {
    throw new NotFoundError('Deployment not found');
  }

  await getBotById(deployment.botId, userId);

  const domains = await prisma.deploymentDomain.findMany({
    where: { deploymentId },
    orderBy: { createdAt: 'asc' },
  });

  return domains.map((d: any) => ({
    id: d.id,
    deploymentId: d.deploymentId,
    domain: d.domain,
    createdAt: d.createdAt.toISOString(),
  }));
};

/**
 * Add a domain to a deployment's allowlist (CP-4.7, CP-4.11).
 */
export const addDomain = async (
  deploymentId: string,
  domain: string,
  userId: string
): Promise<DeploymentDomainDTO> => {
  const deployment = await prisma.botDeployment.findUnique({
    where: { id: deploymentId },
    select: { botId: true },
  });

  if (!deployment) {
    throw new NotFoundError('Deployment not found');
  }

  await getBotById(deployment.botId, userId);

  const normalizedDomain = domain.trim().toLowerCase();

  if (!isValidDomain(normalizedDomain)) {
    throw new ValidationError(
      'Invalid domain format. Provide a valid hostname without protocol, port, or path (e.g. example.com).'
    );
  }

  const existing = await prisma.deploymentDomain.findUnique({
    where: {
      deploymentId_domain: {
        deploymentId,
        domain: normalizedDomain,
      },
    },
  });

  if (existing) {
    return {
      id: existing.id,
      deploymentId: existing.deploymentId,
      domain: existing.domain,
      createdAt: existing.createdAt.toISOString(),
    };
  }

  const created = await prisma.deploymentDomain.create({
    data: {
      deploymentId,
      domain: normalizedDomain,
    },
  });

  return {
    id: created.id,
    deploymentId: created.deploymentId,
    domain: created.domain,
    createdAt: created.createdAt.toISOString(),
  };
};

/**
 * Remove a domain from a deployment's allowlist (CP-4.7).
 */
export const removeDomain = async (
  deploymentId: string,
  domainOrId: string,
  userId: string
): Promise<{ success: boolean }> => {
  const deployment = await prisma.botDeployment.findUnique({
    where: { id: deploymentId },
    select: { botId: true },
  });

  if (!deployment) {
    throw new NotFoundError('Deployment not found');
  }

  await getBotById(deployment.botId, userId);

  const normalized = domainOrId.trim().toLowerCase();

  const domainRecord = await prisma.deploymentDomain.findFirst({
    where: {
      deploymentId,
      OR: [{ id: domainOrId }, { domain: normalized }],
    },
  });

  if (!domainRecord) {
    throw new NotFoundError('Domain not found');
  }

  await prisma.deploymentDomain.delete({
    where: { id: domainRecord.id },
  });

  return { success: true };
};
