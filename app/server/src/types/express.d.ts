import type { WorkspaceMember } from '@prisma/client';
import type { AuthUser } from './common.types.js';

// Declaration merging: make the authenticated user available as `req.user`
// on every Express request, fully typed (no `any`) — spec §9.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /**
       * Resolved by `requireWorkspacePermission` after a successful check. Downstream
       * handlers can scope queries to this workspace without re-resolving the id or
       * re-reading the membership.
       */
      workspaceContext?: {
        workspaceId: string;
        membership: WorkspaceMember;
      };
    }
  }
}

export {};
