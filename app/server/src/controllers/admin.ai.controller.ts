import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { aiServiceClient } from '../services/aiServiceClient.js';

export const classify = asyncHandler(async (req: Request, res: Response) => {
  const result = await aiServiceClient.classifyIntent(req.body);
  sendSuccess(res, result, 'Classification successful', 200);
});

export const getAiStatus = asyncHandler(async (req: Request, res: Response) => {
  const result = await aiServiceClient.getAiStatus();
  sendSuccess(res, result, 'AI status retrieved', 200);
});

export const getMlStatus = asyncHandler(async (req: Request, res: Response) => {
  const result = await aiServiceClient.getMlStatus();
  sendSuccess(res, result, 'ML status retrieved', 200);
});

export const evaluateMlModel = asyncHandler(async (req: Request, res: Response) => {
  const result = await aiServiceClient.evaluateMlModel();
  sendSuccess(res, result, 'ML model evaluated', 200);
});

export const searchVectors = asyncHandler(async (req: Request, res: Response) => {
  const result = await aiServiceClient.searchVectors(req.body);
  sendSuccess(res, result, 'Vector search successful', 200);
});

export const debugChatPipeline = asyncHandler(async (req: Request, res: Response) => {
  const result = await aiServiceClient.debugChatPipeline(req.body);
  sendSuccess(res, result, 'Debug chat pipeline run successful', 200);
});

export const getSystemStatus = asyncHandler(async (req: Request, res: Response) => {
  const result = await aiServiceClient.getSystemStatus();
  sendSuccess(res, result, 'System status retrieved', 200);
});

export const getVectorStats = asyncHandler(async (req: Request, res: Response) => {
  const result = await aiServiceClient.getVectorStats();
  sendSuccess(res, result, 'Vector stats retrieved', 200);
});
