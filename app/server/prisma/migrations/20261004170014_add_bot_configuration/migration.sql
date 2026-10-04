-- CreateEnum
CREATE TYPE "BotPersonality" AS ENUM ('PROFESSIONAL', 'FRIENDLY', 'CONCISE', 'WARM', 'TECHNICAL', 'CASUAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BotTone" AS ENUM ('NEUTRAL', 'FORMAL', 'FRIENDLY', 'EMPATHETIC', 'DIRECT');

-- CreateEnum
CREATE TYPE "ResponseLength" AS ENUM ('SHORT', 'BALANCED', 'LONG');

-- CreateEnum
CREATE TYPE "KnowledgeStrictness" AS ENUM ('STRICT', 'BALANCED', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "HumanRequestBehavior" AS ENUM ('TRANSFER_AUTOMATICALLY', 'UNAVAILABLE_MESSAGE', 'CONTINUE_WITH_AI');

-- CreateEnum
CREATE TYPE "AfterHoursBehavior" AS ENUM ('MESSAGE_ONLY', 'MESSAGE_AND_ESCALATE', 'ESCALATE');

-- CreateEnum
CREATE TYPE "FeedbackRating" AS ENUM ('UP', 'DOWN');

-- AlterTable
ALTER TABLE "ai_models" ADD COLUMN     "capabilities" JSONB;

-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "fallbackAiModelId" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "escalatedOffHours" BOOLEAN,
ADD COLUMN     "escalationReason" VARCHAR(64);

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "sources" JSONB;

-- CreateTable
CREATE TABLE "bot_configurations" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "displayName" VARCHAR(60),
    "avatarData" BYTEA,
    "avatarMimeType" TEXT,
    "avatarUpdatedAt" TIMESTAMP(3),
    "avatarVersion" INTEGER NOT NULL DEFAULT 0,
    "personality" "BotPersonality" NOT NULL DEFAULT 'PROFESSIONAL',
    "tone" "BotTone" NOT NULL DEFAULT 'NEUTRAL',
    "customPersonality" VARCHAR(500),
    "customInstructions" VARCHAR(4000),
    "responseLanguage" VARCHAR(16) NOT NULL DEFAULT 'AUTO',
    "responseLength" "ResponseLength" NOT NULL DEFAULT 'BALANCED',
    "welcomeMessage" VARCHAR(500),
    "conversationStarter" JSONB,
    "suggestedQuestions" JSONB NOT NULL DEFAULT '[]',
    "inputPlaceholder" VARCHAR(120),
    "thinkingMessages" JSONB NOT NULL DEFAULT '[]',
    "feedbackEnabled" BOOLEAN NOT NULL DEFAULT false,
    "feedbackCollectReason" BOOLEAN NOT NULL DEFAULT true,
    "knowledgeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "knowledgeStrictness" "KnowledgeStrictness" NOT NULL DEFAULT 'BALANCED',
    "showSources" BOOLEAN NOT NULL DEFAULT false,
    "retrievalTopK" INTEGER NOT NULL DEFAULT 3,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "topP" DOUBLE PRECISION,
    "frequencyPenalty" DOUBLE PRECISION,
    "presencePenalty" DOUBLE PRECISION,
    "maxOutputTokens" INTEGER,
    "humanFallbackEnabled" BOOLEAN NOT NULL DEFAULT true,
    "fallbackMessage" VARCHAR(500),
    "humanRequestBehavior" "HumanRequestBehavior" NOT NULL DEFAULT 'TRANSFER_AUTOMATICALLY',
    "handoffMessage" VARCHAR(500),
    "businessHours" JSONB,
    "contactCollection" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_feedback" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "rating" "FeedbackRating" NOT NULL,
    "reason" VARCHAR(120),
    "comment" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "message_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_contacts" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "name" VARCHAR(120),
    "email" VARCHAR(254),
    "phone" VARCHAR(40),
    "orderId" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bot_configurations_botId_key" ON "bot_configurations"("botId");

-- CreateIndex
CREATE UNIQUE INDEX "message_feedback_messageId_key" ON "message_feedback"("messageId");

-- CreateIndex
CREATE INDEX "message_feedback_conversationId_idx" ON "message_feedback"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_contacts_conversationId_key" ON "conversation_contacts"("conversationId");

-- CreateIndex
CREATE INDEX "bots_fallbackAiModelId_idx" ON "bots"("fallbackAiModelId");

-- AddForeignKey
ALTER TABLE "bots" ADD CONSTRAINT "bots_fallbackAiModelId_fkey" FOREIGN KEY ("fallbackAiModelId") REFERENCES "ai_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bot_configurations" ADD CONSTRAINT "bot_configurations_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_contacts" ADD CONSTRAINT "conversation_contacts_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
