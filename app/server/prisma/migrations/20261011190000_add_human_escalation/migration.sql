-- Human escalation, agent assignment, and customer-to-agent messaging.
-- See docs/HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md (CP1).
--
-- The only hand-edited part of this file is the `workspaceId` backfill below. Prisma
-- refuses to add a required column to a populated table, so the column is added
-- nullable, backfilled from `bots.workspaceId`, verified, and only then made NOT NULL.
-- Everything else is verbatim `prisma migrate diff` output.

-- CreateEnum
CREATE TYPE "ConversationEventType" AS ENUM ('ESCALATED', 'CLAIMED', 'ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'AGENT_REPLIED', 'RESOLVED', 'REOPENED');

-- AlterEnum
-- PostgreSQL 12+ allows ADD VALUE inside a transaction; the new labels are not used by
-- any statement in this same migration, which is the one case that is still rejected.
ALTER TYPE "ConversationStatus" ADD VALUE 'HUMAN_ACTIVE';

-- AlterEnum
ALTER TYPE "MessageRole" ADD VALUE 'AGENT';

-- DropIndex
DROP INDEX "messages_conversationId_idx";

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "visitorSessionHash" VARCHAR(64),
-- Added nullable first; a following statement backfills it and sets NOT NULL.
ADD COLUMN     "workspaceId" TEXT;

-- Backfill: every conversation inherits its workspace from its bot.
UPDATE "conversations" c
SET "workspaceId" = b."workspaceId"
FROM "bots" b
WHERE b."id" = c."botId"
  AND c."workspaceId" IS NULL;

-- Guard: fail the migration loudly rather than silently leaving NULLs behind if a row
-- ever exists whose bot has gone missing. A half-populated tenant column is far worse
-- than a failed deploy, because it would leak rows across workspaces later.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "conversations" WHERE "workspaceId" IS NULL) THEN
    RAISE EXCEPTION
      'Cannot set conversations.workspaceId NOT NULL: % row(s) could not be resolved from their bot',
      (SELECT count(*) FROM "conversations" WHERE "workspaceId" IS NULL);
  END IF;
END $$;

ALTER TABLE "conversations" ALTER COLUMN "workspaceId" SET NOT NULL;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "clientMessageId" VARCHAR(64),
ADD COLUMN     "senderId" TEXT;

-- CreateTable
CREATE TABLE "conversation_events" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "actorId" TEXT,
    "eventType" "ConversationEventType" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_events_conversationId_createdAt_idx" ON "conversation_events"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "conversation_events_actorId_idx" ON "conversation_events"("actorId");

-- CreateIndex
CREATE INDEX "conversations_workspaceId_status_idx" ON "conversations"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "conversations_status_assignedAgentId_idx" ON "conversations"("status", "assignedAgentId");

-- CreateIndex
CREATE INDEX "messages_conversationId_createdAt_id_idx" ON "messages"("conversationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "messages_senderId_idx" ON "messages"("senderId");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
