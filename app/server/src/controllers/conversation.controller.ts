import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { getAuthUser } from "../middleware/auth.middleware.js";
import * as conversationService from "../services/conversation.service.js";
import type { CreateMessageInput } from "../schemas/conversation.schema.js";

export const createConversation = asyncHandler(
  async (req: Request, res: Response) => {
    const { id: userId } = getAuthUser(req);
    const conversation = await conversationService.createConversation(
      req.params.botId,
      userId,
    );
    sendSuccess(res, conversation, "Conversation created", 201);
  },
);

export const listConversations = asyncHandler(
  async (req: Request, res: Response) => {
    const { id: userId } = getAuthUser(req);
    const conversations = await conversationService.listConversationsByBot(
      req.params.botId,
      userId,
    );
    sendSuccess(res, conversations, "Conversations retrieved", 200);
  },
);

export const getConversation = asyncHandler(
  async (req: Request, res: Response) => {
    const { id: userId } = getAuthUser(req);
    const conversation = await conversationService.getConversationById(
      req.params.conversationId,
      userId,
    );
    sendSuccess(res, conversation, "Conversation retrieved", 200);
  },
);

/** POST /conversations/:conversationId/messages — the Review 1 chat flow (spec §14). */
export const sendMessage = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const { content } = req.body as CreateMessageInput;
  const result = await conversationService.addMessage(
    req.params.conversationId,
    userId,
    content,
  );
  sendSuccess(res, result, "Message processed", 201);
});
