import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import * as knowledgeService from '../services/knowledge.service.js';
import type { CreateKnowledgeInput, UpdateKnowledgeInput } from '../schemas/knowledge.schema.js';

export const createKnowledge = asyncHandler(async (req: Request, res: Response) => {
  const { id: ownerId } = getAuthUser(req);
  const entry = await knowledgeService.createKnowledge(
    req.params.botId,
    ownerId,
    req.body as CreateKnowledgeInput
  );
  sendSuccess(res, entry, 'Knowledge entry created', 201);
});

export const listKnowledge = asyncHandler(async (req: Request, res: Response) => {
  const { id: ownerId } = getAuthUser(req);
  const entries = await knowledgeService.listKnowledgeByBot(req.params.botId, ownerId);
  sendSuccess(res, entries, 'Knowledge entries retrieved', 200);
});

export const updateKnowledge = asyncHandler(async (req: Request, res: Response) => {
  const { id: ownerId } = getAuthUser(req);
  const entry = await knowledgeService.updateKnowledge(
    req.params.knowledgeId,
    ownerId,
    req.body as UpdateKnowledgeInput
  );
  sendSuccess(res, entry, 'Knowledge entry updated', 200);
});

export const deleteKnowledge = asyncHandler(async (req: Request, res: Response) => {
  const { id: ownerId } = getAuthUser(req);
  await knowledgeService.deleteKnowledge(req.params.knowledgeId, ownerId);
  sendSuccess(res, null, 'Knowledge entry deleted', 200);
});

export const deleteAllKnowledge = asyncHandler(async (req: Request, res: Response) => {
  const { id: ownerId } = getAuthUser(req);
  await knowledgeService.deleteAllKnowledge(req.params.botId, ownerId);
  sendSuccess(res, null, 'All knowledge entries deleted for bot', 200);
});
