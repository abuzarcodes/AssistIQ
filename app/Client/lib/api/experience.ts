import { apiGet, apiPatch, apiPost } from '@/lib/api-client';

/**
 * Bot Experience Studio — draft, publishing and versioning API.
 *
 * The server is the source of truth for defaults and for the effective values that
 * fall back to the bot configuration. This module therefore defines no defaults of
 * its own: a null field means "not overridden", and the server's `effective` block
 * says what the customer will actually see.
 */

export type ExperienceThemeMode = 'light' | 'dark' | 'system';
export type ExperienceThemePreset = 'minimal' | 'professional' | 'friendly' | 'dark';
export type WidgetPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type WidgetMobileBehavior = 'fullscreen' | 'modal' | 'bottom-sheet';
export type FirstOpenBehavior = 'welcome' | 'empty' | 'prompt';

export type DeploymentFormat = 'HOSTED_PAGE' | 'WIDGET' | 'IFRAME';
export type DeploymentStatus = 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';

/**
 * The appearance/behaviour settings owned by the experience draft. Everything
 * here is presentational; how the bot answers remains `BotConfiguration`'s job.
 */
export interface ExperienceConfigSnapshot {
  displayName: string | null;
  botAvatarUrl: string | null;
  businessLogoUrl: string | null;
  accentColor: string;
  userBubbleColor: string | null;
  botBubbleColor: string | null;
  themeMode: string;
  themePreset: string | null;

  hostedPageTitle: string | null;
  hostedPageDescription: string | null;
  widgetPosition: string;
  widgetLauncherLabel: string | null;
  widgetPanelWidth: number;
  widgetPanelHeight: number;
  widgetMobileBehavior: string;
  iframeWidth: string;
  iframeHeight: string;

  welcomeMessage: string | null;
  welcomeSubtitle: string | null;
  inputPlaceholder: string | null;
  suggestedQuestions: string[];
  firstOpenBehavior: string;

  showTimestamps: boolean;
  autoOpen: boolean;
  privacyPolicyUrl: string | null;
  termsUrl: string | null;
  showBranding: boolean;
}

export interface ExperienceDeployment {
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
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceVersion {
  id: string;
  experienceId: string;
  versionNumber: number;
  config: ExperienceConfigSnapshot;
  publishedAt: string;
  publishedBy: string;
}

export interface ExperienceEffectiveSettings {
  displayName: string;
  welcomeMessage: string | null;
  suggestedQuestions: string[];
  isDisplayNameOverridden: boolean;
  isWelcomeMessageOverridden: boolean;
  isSuggestedQuestionsOverridden: boolean;
}

export interface ExperienceResponse extends ExperienceConfigSnapshot {
  id: string;
  botId: string;
  version: number;
  publishedVersionId: string | null;
  publishedVersion: ExperienceVersion | null;
  deployments: ExperienceDeployment[];
  effective: ExperienceEffectiveSettings;
  createdAt: string;
  updatedAt: string;
}

/** A partial draft update; `expectedVersion` is the optimistic-concurrency token. */
export type ExperienceDraftPatch = Partial<ExperienceConfigSnapshot> & {
  expectedVersion?: number;
};

/** GET /bots/:botId/experience — read the draft (creating defaults on first access). */
export function getExperience(botId: string) {
  return apiGet<ExperienceResponse>(`/bots/${botId}/experience`);
}

/** PATCH /bots/:botId/experience — save changed draft fields. */
export function updateExperience(botId: string, patch: ExperienceDraftPatch) {
  return apiPatch<ExperienceResponse>(`/bots/${botId}/experience`, patch);
}

/** POST /bots/:botId/experience/publish — snapshot the draft and go live. */
export function publishExperience(botId: string, expectedVersion?: number) {
  return apiPost<ExperienceResponse>(
    `/bots/${botId}/experience/publish`,
    expectedVersion === undefined ? {} : { expectedVersion },
  );
}

/** POST /bots/:botId/experience/unpublish — revoke all public access. */
export function unpublishExperience(botId: string) {
  return apiPost<ExperienceResponse>(`/bots/${botId}/experience/unpublish`);
}

/** GET /bots/:botId/experience/versions — newest first. */
export function listExperienceVersions(botId: string) {
  return apiGet<ExperienceVersion[]>(`/bots/${botId}/experience/versions`);
}

/** GET /bots/:botId/experience/versions/:versionId — one immutable snapshot. */
export function getExperienceVersion(botId: string, versionId: string) {
  return apiGet<ExperienceVersion>(
    `/bots/${botId}/experience/versions/${versionId}`,
  );
}

/**
 * POST /bots/:botId/experience/versions/:versionId/rollback — copy a snapshot
 * into the draft. It deliberately does not publish: the owner reviews and
 * publishes when ready.
 */
export function rollbackExperienceVersion(botId: string, versionId: string) {
  return apiPost<ExperienceResponse>(
    `/bots/${botId}/experience/versions/${versionId}/rollback`,
  );
}
