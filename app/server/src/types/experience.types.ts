import type { DeploymentFormat, DeploymentStatus } from '@prisma/client';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemePreset = 'minimal' | 'professional' | 'friendly' | 'dark';
export type WidgetPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type WidgetMobileBehavior = 'fullscreen' | 'modal' | 'bottom-sheet';
export type FirstOpenBehavior = 'welcome' | 'empty' | 'prompt';

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

export interface BotDeploymentDTO {
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

export interface BotExperienceVersionDTO {
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
  publishedVersion: BotExperienceVersionDTO | null;
  deployments: BotDeploymentDTO[];
  effective: ExperienceEffectiveSettings;
  createdAt: string;
  updatedAt: string;
}
