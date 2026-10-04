import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendSuccess } from "../utils/apiResponse.js";
import { getAuthUser } from "../middleware/auth.middleware.js";
import * as conversationService from "../services/conversation.service.js";
import * as messageFeedbackService from "../services/messageFeedback.service.js";
import * as conversationContactService from "../services/conversationContact.service.js";
import type { CreateMessageInput } from "../schemas/conversation.schema.js";
import type {
  ConversationContactInput,
  MessageFeedbackInput,
} from "../schemas/botConfig.schema.js";

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

/** POST /conversations/:conversationId/messages/:messageId/feedback (§10.6). */
export const upsertFeedback = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const feedback = await messageFeedbackService.upsertFeedback(
    req.params.conversationId,
    req.params.messageId,
    userId,
    req.body as MessageFeedbackInput,
  );
  sendSuccess(res, feedback, "Feedback recorded", 200);
});

/** DELETE /conversations/:conversationId/messages/:messageId/feedback (§10.6). */
export const deleteFeedback = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  await messageFeedbackService.deleteFeedback(
    req.params.conversationId,
    req.params.messageId,
    userId,
  );
  sendSuccess(res, null, "Feedback removed", 200);
});

/** POST /conversations/:conversationId/contact (§10.7). */
export const upsertContact = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const contact = await conversationContactService.upsertContact(
    req.params.conversationId,
    userId,
    req.body as ConversationContactInput,
  );
  sendSuccess(res, contact, "Contact details recorded", 200);
});
