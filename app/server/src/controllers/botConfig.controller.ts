import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import { ValidationError } from '../utils/errors.js';
import * as botConfigService from '../services/botConfig.service.js';
import * as avatarService from '../services/avatar.service.js';
import type {
  PreviewConfigInput,
  ResetBotConfigInput,
  UpdateBotConfigInput,
} from '../schemas/botConfig.schema.js';
import type { UploadedAvatarLike } from '../services/avatar.service.js';

/**
 * Bot configuration and avatar endpoints (BOT_IMPLEMENTATION_PLAN.md §10.1, §10.2).
 *
 * Handlers orchestrate only: authorization is applied by the route (`bots:view` /
 * `bots:manage`, scoped `{from:'bot'}`) and membership scoping by the service
 * (`getBotById` → 404). Nothing about *who* may read or write is decided here.
 */

export const getConfig = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const config = await botConfigService.getBotConfigResponse(req.params.botId!, userId);
  sendSuccess(res, config, 'Bot configuration retrieved', 200);
});

export const updateConfig = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const config = await botConfigService.updateBotConfig(
    req.params.botId!,
    userId,
    req.body as UpdateBotConfigInput
  );
  sendSuccess(res, config, 'Bot configuration updated', 200);
});

export const resetConfig = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const config = await botConfigService.resetBotConfig(
    req.params.botId!,
    userId,
    req.body as ResetBotConfigInput
  );
  sendSuccess(res, config, 'Bot configuration reset', 200);
});

/** POST /bots/:botId/config/preview — test a draft without persisting anything (§17.2). */
export const previewConfig = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const result = await botConfigService.previewConfig(
    req.params.botId!,
    userId,
    req.body as PreviewConfigInput
  );
  sendSuccess(res, result, 'Preview generated', 200);
});

export const uploadAvatar = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);

  // Multer stores into `req.file`. Reaching this handler without one means either the client
  // sent no file part or sent it under the wrong field name; both are the same 400, because
  // the caller's fix is the same and naming the field would only describe our parser.
  if (!req.file) {
    throw new ValidationError('An image file is required.');
  }

  const state = await avatarService.saveAvatar(
    req.params.botId!,
    userId,
    req.file as unknown as UploadedAvatarLike
  );

  sendSuccess(res, state, 'Avatar updated', 201);
});

export const deleteAvatar = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const state = await avatarService.clearAvatar(req.params.botId!, userId);
  sendSuccess(res, state, 'Avatar removed', 200);
});

/**
 * Serve the avatar bytes.
 *
 * The response is the image itself, not the `{success, message, data}` envelope — an
 * `<img src>` cannot unwrap a JSON body, and this URL is meant to be usable directly in one.
 * That makes this the only non-enveloped route in the API, which is why it is called out
 * here rather than left to be discovered.
 *
 * `Cache-Control: private` is load-bearing, not decoration. The URL carries no token — the
 * browser sends the session cookie or the client fetches it — so a shared proxy that cached
 * this response would hand one workspace's bot avatar to another tenant. `private` forbids
 * that, while `max-age=0, must-revalidate` keeps the *browser* from re-rendering a stale
 * image after an upload; the `ETag` makes that revalidation a cheap 304 in the common case.
 */
export const getAvatar = asyncHandler(async (req: Request, res: Response) => {
  const { id: userId } = getAuthUser(req);
  const avatar = await avatarService.getAvatar(req.params.botId!, userId);

  if (req.headers['if-none-match'] === avatar.etag) {
    res.status(304).end();
    return;
  }

  res.setHeader('Content-Type', avatar.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('ETag', avatar.etag);
  // Immutable content: the URL only changes shape when a new version is written, and the
  // version is part of the ETag, so a stale entry cannot be served under a fresh validator.
  res.setHeader('Content-Length', String(avatar.data.length));
  res.status(200).end(avatar.data);
});
