import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { getAuthUser } from '../middleware/auth.middleware.js';
import * as userService from '../services/user.service.js';

/** GET /api/v1/users/me — the authenticated user's safe profile. */
export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const { id } = getAuthUser(req);
  const user = await userService.getUserById(id);
  sendSuccess(res, user, 'Current user retrieved', 200);
});
