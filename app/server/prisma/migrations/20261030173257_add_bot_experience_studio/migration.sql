-- CreateEnum
CREATE TYPE "DeploymentFormat" AS ENUM ('HOSTED_PAGE', 'WIDGET', 'IFRAME');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'UNPUBLISHED');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "deploymentId" TEXT;

-- CreateTable
CREATE TABLE "bot_experiences" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "displayName" VARCHAR(60),
    "botAvatarUrl" VARCHAR(500),
    "businessLogoUrl" VARCHAR(500),
    "accentColor" VARCHAR(9) NOT NULL DEFAULT '#ff6b35',
    "userBubbleColor" VARCHAR(9),
    "botBubbleColor" VARCHAR(9),
    "themeMode" VARCHAR(10) NOT NULL DEFAULT 'system',
    "themePreset" VARCHAR(20),
    "hostedPageTitle" VARCHAR(120),
    "hostedPageDescription" VARCHAR(500),
    "widgetPosition" VARCHAR(20) NOT NULL DEFAULT 'bottom-right',
    "widgetLauncherLabel" VARCHAR(40),
    "widgetPanelWidth" INTEGER NOT NULL DEFAULT 400,
    "widgetPanelHeight" INTEGER NOT NULL DEFAULT 600,
    "widgetMobileBehavior" VARCHAR(20) NOT NULL DEFAULT 'fullscreen',
    "iframeWidth" VARCHAR(20) NOT NULL DEFAULT '100%',
    "iframeHeight" VARCHAR(20) NOT NULL DEFAULT '600px',
    "welcomeMessage" VARCHAR(500),
    "welcomeSubtitle" VARCHAR(200),
    "inputPlaceholder" VARCHAR(120),
    "suggestedQuestions" JSONB NOT NULL DEFAULT '[]',
    "firstOpenBehavior" VARCHAR(20) NOT NULL DEFAULT 'welcome',
    "showTimestamps" BOOLEAN NOT NULL DEFAULT true,
    "autoOpen" BOOLEAN NOT NULL DEFAULT false,
    "privacyPolicyUrl" VARCHAR(500),
    "termsUrl" VARCHAR(500),
    "showBranding" BOOLEAN NOT NULL DEFAULT true,
    "publishedVersionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_experiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_experience_versions" (
    "id" TEXT NOT NULL,
    "experienceId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" TEXT NOT NULL,

    CONSTRAINT "bot_experience_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_deployments" (
    "id" TEXT NOT NULL,
    "experienceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "format" "DeploymentFormat" NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'DRAFT',
    "slug" VARCHAR(80),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "unpublishedAt" TIMESTAMP(3),
    "publishEpoch" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_domains" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_events" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventType" VARCHAR(40) NOT NULL,
    "sessionId" VARCHAR(64),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_experiences_botId_key" ON "bot_experiences"("botId");

-- CreateIndex
CREATE INDEX "bot_experience_versions_experienceId_idx" ON "bot_experience_versions"("experienceId");

-- CreateIndex
CREATE UNIQUE INDEX "bot_experience_versions_experienceId_versionNumber_key" ON "bot_experience_versions"("experienceId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "bot_deployments_slug_key" ON "bot_deployments"("slug");

-- CreateIndex
CREATE INDEX "bot_deployments_botId_idx" ON "bot_deployments"("botId");

-- CreateIndex
CREATE INDEX "bot_deployments_slug_idx" ON "bot_deployments"("slug");

-- CreateIndex
CREATE INDEX "bot_deployments_status_idx" ON "bot_deployments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "bot_deployments_experienceId_format_key" ON "bot_deployments"("experienceId", "format");

-- CreateIndex
CREATE INDEX "deployment_domains_deploymentId_idx" ON "deployment_domains"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_domains_deploymentId_domain_key" ON "deployment_domains"("deploymentId", "domain");

-- CreateIndex
CREATE INDEX "deployment_events_deploymentId_eventType_createdAt_idx" ON "deployment_events"("deploymentId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "deployment_events_botId_createdAt_idx" ON "deployment_events"("botId", "createdAt");

-- CreateIndex
CREATE INDEX "deployment_events_workspaceId_createdAt_idx" ON "deployment_events"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "conversations_deploymentId_idx" ON "conversations"("deploymentId");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "bot_deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_experiences" ADD CONSTRAINT "bot_experiences_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_experiences" ADD CONSTRAINT "bot_experiences_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "bot_experience_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_experience_versions" ADD CONSTRAINT "bot_experience_versions_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "bot_experiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_experience_versions" ADD CONSTRAINT "bot_experience_versions_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_deployments" ADD CONSTRAINT "bot_deployments_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "bot_experiences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_domains" ADD CONSTRAINT "deployment_domains_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "bot_deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
