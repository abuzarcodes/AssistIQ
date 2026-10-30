import crypto from 'node:crypto';
import type { Prisma, BotExperience, BotExperienceVersion, BotDeployment } from '@prisma/client';
import prisma from '../config/database.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { getBotById } from './bot.service.js';
import { EXPERIENCE_DEFAULTS } from '../constants/experienceDefaults.js';
import type { UpdateExperienceInput, PublishExperienceInput } from '../schemas/experience.schema.js';
import type {
  ExperienceResponse,
  BotDeploymentDTO,
  BotExperienceVersionDTO,
  ExperienceConfigSnapshot,
} from '../types/experience.types.js';
import { evictBotVisitorSockets } from '../realtime/socketServer.js';

type ExperienceWithRelations = BotExperience & {
  publishedVersion: BotExperienceVersion | null;
  deployments: BotDeployment[];
};

/**
 * Generate a URL-friendly slug from bot name + random hex suffix.
 */
export const generateSlug = (botName: string): string => {
  const base = botName
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'bot';
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${base}-${suffix}`;
};

/**
 * Format a deployment row into a clean DTO.
 */
export const formatDeploymentDTO = (deployment: BotDeployment): BotDeploymentDTO => ({
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
  createdAt: deployment.createdAt.toISOString(),
  updatedAt: deployment.updatedAt.toISOString(),
});

/**
 * Format a version row into a clean DTO.
 */
export const formatVersionDTO = (version: BotExperienceVersion): BotExperienceVersionDTO => ({
  id: version.id,
  experienceId: version.experienceId,
  versionNumber: version.versionNumber,
  config: version.config as unknown as ExperienceConfigSnapshot,
  publishedAt: version.publishedAt.toISOString(),
  publishedBy: version.publishedBy,
});

/**
 * Extract an immutable snapshot of all experience settings at publish time.
 */
export const extractSnapshot = (exp: BotExperience): ExperienceConfigSnapshot => ({
  displayName: exp.displayName,
  botAvatarUrl: exp.botAvatarUrl,
  businessLogoUrl: exp.businessLogoUrl,
  accentColor: exp.accentColor,
  userBubbleColor: exp.userBubbleColor,
  botBubbleColor: exp.botBubbleColor,
  themeMode: exp.themeMode,
  themePreset: exp.themePreset,

  hostedPageTitle: exp.hostedPageTitle,
  hostedPageDescription: exp.hostedPageDescription,
  widgetPosition: exp.widgetPosition,
  widgetLauncherLabel: exp.widgetLauncherLabel,
  widgetPanelWidth: exp.widgetPanelWidth,
  widgetPanelHeight: exp.widgetPanelHeight,
  widgetMobileBehavior: exp.widgetMobileBehavior,
  iframeWidth: exp.iframeWidth,
  iframeHeight: exp.iframeHeight,

  welcomeMessage: exp.welcomeMessage,
  welcomeSubtitle: exp.welcomeSubtitle,
  inputPlaceholder: exp.inputPlaceholder,
  suggestedQuestions: (Array.isArray(exp.suggestedQuestions)
    ? exp.suggestedQuestions
    : []) as string[],
  firstOpenBehavior: exp.firstOpenBehavior,

  showTimestamps: exp.showTimestamps,
  autoOpen: exp.autoOpen,
  privacyPolicyUrl: exp.privacyPolicyUrl,
  termsUrl: exp.termsUrl,
  showBranding: exp.showBranding,
});

/**
 * Validate that draft has minimum required settings to be published.
 */
const validateDraftForPublish = (exp: ExperienceResponse) => {
  if (!exp.effective.displayName || exp.effective.displayName.trim().length === 0) {
    throw new ValidationError('A display name or bot name is required to publish.');
  }
};

/**
 * Helper to compute effective values based on experience overrides and bot configuration fallbacks.
 */
const formatExperienceResponse = async (
  botId: string,
  exp: ExperienceWithRelations
): Promise<ExperienceResponse> => {
  const botWithConfig = await prisma.bot.findUnique({
    where: { id: botId },
    include: { configuration: true },
  });

  const botConfig = botWithConfig?.configuration;
  const botName = botWithConfig?.name || 'AI Assistant';

  const suggestedQuestions = (Array.isArray(exp.suggestedQuestions)
    ? exp.suggestedQuestions
    : []) as string[];
  const configSuggestedQuestions = (Array.isArray(botConfig?.suggestedQuestions)
    ? botConfig.suggestedQuestions
    : []) as string[];

  const effectiveDisplayName = exp.displayName || botConfig?.displayName || botName;
  const effectiveWelcomeMessage =
    exp.welcomeMessage !== null && exp.welcomeMessage !== undefined
      ? exp.welcomeMessage
      : botConfig?.welcomeMessage ?? null;
  const effectiveSuggestedQuestions =
    suggestedQuestions.length > 0 ? suggestedQuestions : configSuggestedQuestions;

  return {
    id: exp.id,
    botId: exp.botId,
    displayName: exp.displayName,
    botAvatarUrl: exp.botAvatarUrl,
    businessLogoUrl: exp.businessLogoUrl,
    accentColor: exp.accentColor,
    userBubbleColor: exp.userBubbleColor,
    botBubbleColor: exp.botBubbleColor,
    themeMode: exp.themeMode,
    themePreset: exp.themePreset,

    hostedPageTitle: exp.hostedPageTitle,
    hostedPageDescription: exp.hostedPageDescription,
    widgetPosition: exp.widgetPosition,
    widgetLauncherLabel: exp.widgetLauncherLabel,
    widgetPanelWidth: exp.widgetPanelWidth,
    widgetPanelHeight: exp.widgetPanelHeight,
    widgetMobileBehavior: exp.widgetMobileBehavior,
    iframeWidth: exp.iframeWidth,
    iframeHeight: exp.iframeHeight,

    welcomeMessage: exp.welcomeMessage,
    welcomeSubtitle: exp.welcomeSubtitle,
    inputPlaceholder: exp.inputPlaceholder,
    suggestedQuestions,
    firstOpenBehavior: exp.firstOpenBehavior,

    showTimestamps: exp.showTimestamps,
    autoOpen: exp.autoOpen,
    privacyPolicyUrl: exp.privacyPolicyUrl,
    termsUrl: exp.termsUrl,
    showBranding: exp.showBranding,

    version: exp.version,
    publishedVersionId: exp.publishedVersionId,
    publishedVersion: exp.publishedVersion ? formatVersionDTO(exp.publishedVersion) : null,
    deployments: (exp.deployments || []).map(formatDeploymentDTO),

    effective: {
      displayName: effectiveDisplayName,
      welcomeMessage: effectiveWelcomeMessage,
      suggestedQuestions: effectiveSuggestedQuestions,
      isDisplayNameOverridden: Boolean(exp.displayName),
      isWelcomeMessageOverridden: exp.welcomeMessage !== null && exp.welcomeMessage !== undefined,
      isSuggestedQuestionsOverridden: suggestedQuestions.length > 0,
    },

    createdAt: exp.createdAt.toISOString(),
    updatedAt: exp.updatedAt.toISOString(),
  };
};

/**
 * Get or automatically create the draft experience configuration for a bot.
 * Asserts workspace membership of the calling user.
 */
export const getOrCreateExperience = async (
  botId: string,
  userId: string
): Promise<ExperienceResponse> => {
  await getBotById(botId, userId);

  let experience = await prisma.botExperience.findUnique({
    where: { botId },
    include: {
      publishedVersion: true,
      deployments: true,
    },
  });

  if (!experience) {
    experience = await prisma.botExperience.create({
      data: {
        botId,
        ...EXPERIENCE_DEFAULTS,
      },
      include: {
        publishedVersion: true,
        deployments: true,
      },
    });
  }

  return formatExperienceResponse(botId, experience);
};

/**
 * Fetch the experience configuration for a bot.
 */
export const getExperience = async (
  botId: string,
  userId: string
): Promise<ExperienceResponse> => {
  return getOrCreateExperience(botId, userId);
};

/**
 * Partially update the draft experience configuration with optimistic concurrency.
 */
export const updateExperience = async (
  botId: string,
  userId: string,
  input: UpdateExperienceInput
): Promise<ExperienceResponse> => {
  await getBotById(botId, userId);

  const current = await getOrCreateExperience(botId, userId);

  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    throw new AppError(
      'This experience was changed by someone else. Reload to see the latest settings.',
      409,
      true,
      current
    );
  }

  const { expectedVersion: _, ...updateData } = input;

  const updated = await prisma.botExperience.update({
    where: { botId },
    data: {
      ...updateData,
      version: { increment: 1 },
    },
    include: {
      publishedVersion: true,
      deployments: true,
    },
  });

  return formatExperienceResponse(botId, updated);
};

/**
 * Publish the current draft experience (Phase 2, CP-2.1).
 * Validates completeness, creates immutable version snapshot, updates/creates deployments for all 3 formats.
 */
export const publishExperience = async (
  botId: string,
  userId: string,
  input?: PublishExperienceInput
): Promise<ExperienceResponse> => {
  const bot = await getBotById(botId, userId);
  const current = await getOrCreateExperience(botId, userId);

  if (input?.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    throw new AppError(
      'This experience was changed by someone else. Reload to see the latest settings.',
      409,
      true,
      current
    );
  }

  validateDraftForPublish(current);

  const rawExp = await prisma.botExperience.findUniqueOrThrow({
    where: { botId },
  });

  const snapshot = extractSnapshot(rawExp);

  // Auto-increment version number per experience
  const latestVersion = await prisma.botExperienceVersion.findFirst({
    where: { experienceId: rawExp.id },
    orderBy: { versionNumber: 'desc' },
  });
  const nextVersionNumber = (latestVersion?.versionNumber ?? 0) + 1;

  const updatedExperience = await prisma.$transaction(async (tx) => {
    // 1. Create immutable snapshot version
    const newVersion = await tx.botExperienceVersion.create({
      data: {
        experienceId: rawExp.id,
        versionNumber: nextVersionNumber,
        config: snapshot as unknown as Prisma.InputJsonValue,
        publishedBy: userId,
      },
    });

    // 2. Update experience publishedVersionId and bump optimistic concurrency version
    await tx.botExperience.update({
      where: { id: rawExp.id },
      data: {
        publishedVersionId: newVersion.id,
        version: { increment: 1 },
      },
    });

    // 3. Upsert deployments for all three formats
    // Hosted Page
    const existingHosted = await tx.botDeployment.findUnique({
      where: {
        experienceId_format: {
          experienceId: rawExp.id,
          format: 'HOSTED_PAGE',
        },
      },
    });

    if (existingHosted) {
      await tx.botDeployment.update({
        where: { id: existingHosted.id },
        data: {
          status: 'PUBLISHED',
          enabled: true,
          unpublishedAt: null,
        },
      });
    } else {
      let slug = generateSlug(bot.name);
      const slugExists = await tx.botDeployment.findUnique({ where: { slug } });
      if (slugExists) {
        slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`;
      }
      await tx.botDeployment.create({
        data: {
          experienceId: rawExp.id,
          botId,
          workspaceId: bot.workspaceId,
          format: 'HOSTED_PAGE',
          status: 'PUBLISHED',
          enabled: true,
          slug,
        },
      });
    }

    // Widget
    const existingWidget = await tx.botDeployment.findUnique({
      where: {
        experienceId_format: {
          experienceId: rawExp.id,
          format: 'WIDGET',
        },
      },
    });
    if (existingWidget) {
      await tx.botDeployment.update({
        where: { id: existingWidget.id },
        data: {
          status: 'PUBLISHED',
          enabled: true,
          unpublishedAt: null,
        },
      });
    } else {
      await tx.botDeployment.create({
        data: {
          experienceId: rawExp.id,
          botId,
          workspaceId: bot.workspaceId,
          format: 'WIDGET',
          status: 'PUBLISHED',
          enabled: true,
        },
      });
    }

    // Iframe
    const existingIframe = await tx.botDeployment.findUnique({
      where: {
        experienceId_format: {
          experienceId: rawExp.id,
          format: 'IFRAME',
        },
      },
    });
    if (existingIframe) {
      await tx.botDeployment.update({
        where: { id: existingIframe.id },
        data: {
          status: 'PUBLISHED',
          enabled: true,
          unpublishedAt: null,
        },
      });
    } else {
      await tx.botDeployment.create({
        data: {
          experienceId: rawExp.id,
          botId,
          workspaceId: bot.workspaceId,
          format: 'IFRAME',
          status: 'PUBLISHED',
          enabled: true,
        },
      });
    }

    return tx.botExperience.findUniqueOrThrow({
      where: { id: rawExp.id },
      include: {
        publishedVersion: true,
        deployments: true,
      },
    });
  });

  return formatExperienceResponse(botId, updatedExperience);
};

/**
 * Unpublish the experience (Phase 2, CP-2.4).
 * Sets all deployments to UNPUBLISHED, bumps publishEpoch, records unpublishedAt, preserves versions.
 */
export const unpublishExperience = async (
  botId: string,
  userId: string
): Promise<ExperienceResponse> => {
  await getBotById(botId, userId);
  await getOrCreateExperience(botId, userId);

  const rawExp = await prisma.botExperience.findUniqueOrThrow({
    where: { botId },
  });

  await prisma.$transaction(async (tx) => {
    await tx.botDeployment.updateMany({
      where: { experienceId: rawExp.id },
      data: {
        status: 'UNPUBLISHED',
        unpublishedAt: new Date(),
        publishEpoch: { increment: 1 },
      },
    });

    await tx.botExperience.update({
      where: { id: rawExp.id },
      data: {
        version: { increment: 1 },
      },
    });
  });

  // Evict all active visitor sockets for this bot (CP-3.8)
  await evictBotVisitorSockets(botId);

  const updated = await prisma.botExperience.findUniqueOrThrow({
    where: { id: rawExp.id },
    include: {
      publishedVersion: true,
      deployments: true,
    },
  });

  return formatExperienceResponse(botId, updated);
};

/**
 * List all versions for a bot's experience ordered by versionNumber DESC (CP-2.5).
 */
export const listVersions = async (
  botId: string,
  userId: string
): Promise<BotExperienceVersionDTO[]> => {
  await getBotById(botId, userId);
  const exp = await getOrCreateExperience(botId, userId);

  const versions = await prisma.botExperienceVersion.findMany({
    where: { experienceId: exp.id },
    orderBy: { versionNumber: 'desc' },
  });

  return versions.map(formatVersionDTO);
};

/**
 * Get a specific version config (CP-2.6).
 */
export const getVersion = async (
  botId: string,
  versionId: string,
  userId: string
): Promise<BotExperienceVersionDTO> => {
  await getBotById(botId, userId);
  const exp = await getOrCreateExperience(botId, userId);

  const version = await prisma.botExperienceVersion.findFirst({
    where: {
      id: versionId,
      experienceId: exp.id,
    },
  });

  if (!version) {
    throw new NotFoundError('Version not found');
  }

  return formatVersionDTO(version);
};

/**
 * Rollback draft to an earlier version's configuration (CP-2.7).
 * Copies snapshot into current draft and increments version. Does NOT auto-publish.
 */
export const rollbackToVersion = async (
  botId: string,
  versionId: string,
  userId: string
): Promise<ExperienceResponse> => {
  await getBotById(botId, userId);
  const exp = await getOrCreateExperience(botId, userId);

  const version = await prisma.botExperienceVersion.findFirst({
    where: {
      id: versionId,
      experienceId: exp.id,
    },
  });

  if (!version) {
    throw new NotFoundError('Version not found');
  }

  const snapshot = version.config as unknown as ExperienceConfigSnapshot;

  const updated = await prisma.botExperience.update({
    where: { id: exp.id },
    data: {
      displayName: snapshot.displayName,
      botAvatarUrl: snapshot.botAvatarUrl,
      businessLogoUrl: snapshot.businessLogoUrl,
      accentColor: snapshot.accentColor,
      userBubbleColor: snapshot.userBubbleColor,
      botBubbleColor: snapshot.botBubbleColor,
      themeMode: snapshot.themeMode,
      themePreset: snapshot.themePreset,
      hostedPageTitle: snapshot.hostedPageTitle,
      hostedPageDescription: snapshot.hostedPageDescription,
      widgetPosition: snapshot.widgetPosition,
      widgetLauncherLabel: snapshot.widgetLauncherLabel,
      widgetPanelWidth: snapshot.widgetPanelWidth,
      widgetPanelHeight: snapshot.widgetPanelHeight,
      widgetMobileBehavior: snapshot.widgetMobileBehavior,
      iframeWidth: snapshot.iframeWidth,
      iframeHeight: snapshot.iframeHeight,
      welcomeMessage: snapshot.welcomeMessage,
      welcomeSubtitle: snapshot.welcomeSubtitle,
      inputPlaceholder: snapshot.inputPlaceholder,
      suggestedQuestions: snapshot.suggestedQuestions,
      firstOpenBehavior: snapshot.firstOpenBehavior,
      showTimestamps: snapshot.showTimestamps,
      autoOpen: snapshot.autoOpen,
      privacyPolicyUrl: snapshot.privacyPolicyUrl,
      termsUrl: snapshot.termsUrl,
      showBranding: snapshot.showBranding,
      version: { increment: 1 },
    },
    include: {
      publishedVersion: true,
      deployments: true,
    },
  });

  return formatExperienceResponse(botId, updated);
};
