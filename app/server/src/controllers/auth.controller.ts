import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import * as authService from '../services/auth.service.js';
import type { RegisterInput, LoginInput } from '../schemas/auth.schema.js';

// req.body is validated + reshaped by the validation middleware, so the casts below
// are safe assertions of an already-verified shape (Express types body as `any`).

export const register = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.register(req.body as RegisterInput);
  sendSuccess(res, result, 'Registration successful', 201);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.login(req.body as LoginInput);
  sendSuccess(res, result, 'Login successful', 200);
});

/**
 * Logout for stateless bearer JWTs (spec §8): there is no server-side session to
 * invalidate, so the contract is simply that the client discards its token. We do NOT
 * pretend to invalidate the JWT server-side. A token blacklist is a Review 2 item.
 */
export const logout = asyncHandler(async (_req: Request, res: Response) => {
  sendSuccess(res, null, 'Logout successful. Please discard your access token.', 200);
});
