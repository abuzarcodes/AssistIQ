import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import * as knowledgeService from '../services/knowledge.service.js';
import { aiServiceClient } from '../services/aiServiceClient.js';
import { AppError } from '../utils/errors.js';
import type { CreateKnowledgeInput, UpdateKnowledgeInput } from '../schemas/knowledge.schema.js';

export const createKnowledge = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const entry = await knowledgeService.createKnowledge(
    req.params.botId,
    userId,
    req.body as CreateKnowledgeInput
  );
  sendSuccess(res, entry, 'Knowledge entry created', 201);
});

export const listKnowledge = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const entries = await knowledgeService.listKnowledgeByBot(req.params.botId, userId);
  sendSuccess(res, entries, 'Knowledge entries retrieved', 200);
});

export const updateKnowledge = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const entry = await knowledgeService.updateKnowledge(
    req.params.knowledgeId,
    userId,
    req.body as UpdateKnowledgeInput
  );
  sendSuccess(res, entry, 'Knowledge entry updated', 200);
});

export const deleteKnowledge = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  await knowledgeService.deleteKnowledge(req.params.knowledgeId, userId);
  sendSuccess(res, null, 'Knowledge entry deleted', 200);
});

export const deleteAllKnowledge = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  await knowledgeService.deleteAllKnowledge(req.params.botId, userId);
  sendSuccess(res, null, 'All knowledge entries deleted for bot', 200);
});

export const uploadDocument = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const botId = req.params.botId;

  // Verify bot ownership
  await knowledgeService.listKnowledgeByBot(botId, userId);

  const file = req.file;
  if (!file) {
    throw new AppError('No file uploaded. Please upload a PDF or DOCX file.', 400);
  }

  // Build FormData to forward to the Python AI service
  const formData = new FormData();
  const blob = new Blob([file.buffer], { type: file.mimetype });
  formData.append('file', blob, file.originalname);
  formData.append('bot_id', botId);

  if (req.body.topic) {
    formData.append('topic', req.body.topic);
  }

  const result = await aiServiceClient.ingestDocument(formData);
  sendSuccess(res, result, 'Document uploaded and ingested successfully', 201);
});
