import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import * as botService from '../services/bot.service.js';
import type { CreateBotInput, UpdateBotInput, AssignModelInput } from '../schemas/bot.schema.js';

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

/**
 * Assign or clear a bot's catalog model (Checkpoint 3). Authorization (`bots:manage`) is
 * applied by the route, and membership scoping by the service — this handler only
 * orchestrates. `aiModelId: null` is a valid, successful request: it returns the bot to the
 * platform default.
 */
export const assignModel = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const { aiModelId } = req.body as AssignModelInput;
  const bot = await botService.assignBotModel(req.params.botId, userId, aiModelId);
  sendSuccess(res, bot, 'Bot model updated', 200);
});
