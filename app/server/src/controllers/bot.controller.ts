import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import * as botService from '../services/bot.service.js';
import type { CreateBotInput, UpdateBotInput } from '../schemas/bot.schema.js';

export const createBot = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const bot = await botService.createBot(req.params.workspaceId, userId, req.body as CreateBotInput);
  sendSuccess(res, bot, 'Bot created', 201);
});

export const listBots = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const bots = await botService.listBotsByWorkspace(req.params.workspaceId, userId);
  sendSuccess(res, bots, 'Bots retrieved', 200);
});

export const getBot = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const bot = await botService.getBotById(req.params.botId, userId);
  sendSuccess(res, bot, 'Bot retrieved', 200);
});

export const updateBot = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const bot = await botService.updateBot(req.params.botId, userId, req.body as UpdateBotInput);
  sendSuccess(res, bot, 'Bot updated', 200);
});

export const deleteBot = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  await botService.deleteBot(req.params.botId, userId);
  sendSuccess(res, null, 'Bot deleted', 200);
});
