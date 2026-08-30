import type { AuthUser } from './common.types.js';

// Declaration merging: make the authenticated user available as `req.user`
// on every Express request, fully typed (no `any`) — spec §9.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
