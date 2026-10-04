-- CreateEnum
CREATE TYPE "KnowledgeSourceStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileSizeBytes" INTEGER,
    "status" "KnowledgeSourceStatus" NOT NULL DEFAULT 'PENDING',
    "pagesExtracted" INTEGER,
    "chunksCreated" INTEGER,
    "errorMessage" TEXT,
    "topic" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks_meta" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "pageNumber" INTEGER,
    "section" TEXT,
    "topic" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "embeddingModel" TEXT,
    "embeddingDimension" INTEGER,
    "lastEmbeddedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_chunks_meta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "maxUploadFileSizeBytes" INTEGER NOT NULL DEFAULT 10485760,
    "maxUploadFilesPerRequest" INTEGER NOT NULL DEFAULT 10,
    "maxUploadTotalBytes" INTEGER NOT NULL DEFAULT 52428800,
    "maxChunksPerSource" INTEGER NOT NULL DEFAULT 5000,
    "maxChunksPerBot" INTEGER NOT NULL DEFAULT 0,
    "aiServiceMaxFileSizeBytes" INTEGER NOT NULL DEFAULT 104857600,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_sources_botId_idx" ON "knowledge_sources"("botId");

-- CreateIndex
CREATE INDEX "knowledge_sources_status_idx" ON "knowledge_sources"("status");

-- CreateIndex
CREATE INDEX "knowledge_chunks_meta_botId_idx" ON "knowledge_chunks_meta"("botId");

-- CreateIndex
CREATE INDEX "knowledge_chunks_meta_sourceId_idx" ON "knowledge_chunks_meta"("sourceId");

-- CreateIndex
CREATE INDEX "knowledge_chunks_meta_botId_enabled_idx" ON "knowledge_chunks_meta"("botId", "enabled");

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks_meta" ADD CONSTRAINT "knowledge_chunks_meta_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks_meta" ADD CONSTRAINT "knowledge_chunks_meta_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the platform settings singleton.
--
-- The service layer also upserts-on-read, so a missing row can never produce a
-- "no limits configured" state. Seeding here additionally makes the defaults
-- visible in migration history rather than depending on first-read behaviour.
INSERT INTO "platform_settings" ("id", "updatedAt")
VALUES ('singleton', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
