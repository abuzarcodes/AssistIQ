import type { WorkspaceMember } from '@prisma/client';
import type { AuthUser } from './common.types.js';
import type { EffectiveUploadLimits } from './knowledge.types.js';

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
      /**
       * Resolved upload limits, attached by the `uploadLimits` middleware. The multer
       * instance is built per request from this object (section 12.5), which is why it
       * must be present before the parser runs — the parser factory refuses to
       * construct without it rather than falling back to a default.
       *
       * Typed as optional because only the upload routes populate it; the factory
       * narrows it and fails loudly if the middleware order is wrong.
       */
      uploadLimits?: EffectiveUploadLimits;
      /**
       * The byte ceiling the avatar parser was built with.
       *
       * The avatar route deliberately does not run `uploadLimits()` — its ceiling is a
       * constant, not a workspace setting (see `constants/uploads.ts`) — so the multer
       * error mapping has no `req.uploadLimits` to quote. Without this, a 413 on an avatar
       * upload would say "File too large." while every other upload route names the number,
       * and "too large compared to what?" is exactly what the user needs answered.
       */
      avatarMaxBytes?: number;
      /**
       * Resolved by `authenticateVisitor` after a successful visitor-token check (§10.4).
       *
       * The token's own claims are not trusted downstream on their own: the middleware has
       * already re-read the conversation and confirmed the token's `botId` and `workspaceId`
       * still match the row, so these values are the *database's*, not the bearer's.
       *
       * **Identity only — no lifecycle state.** `status` is deliberately not carried here
       * (it was, briefly, during CP3): it is mutable, and any handler that gated on it would
       * be gating on a value that can change between the read and the write it guards. The
       * chat turn reads the status itself at the moment it decides whether to call the AI.
       *
       * Optional because only the public routes populate it; the controller narrows it and
       * fails loudly if the middleware order is wrong, in the same spirit as `uploadLimits`.
       */
      visitorContext?: {
        conversationId: string;
        botId: string;
        workspaceId: string;
      };
    }
  }
}

export {};
