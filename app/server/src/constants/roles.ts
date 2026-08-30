import { MessageRole } from '@prisma/client';

/**
 * Chat message roles. Re-exported from the Prisma-generated enum so application
 * code has a single import site and stays in sync with the database schema.
 */
export { MessageRole };

export const MESSAGE_ROLES = [
  MessageRole.USER,
  MessageRole.ASSISTANT,
  MessageRole.SYSTEM,
] as const;

/**
 * Placeholder for future multi-member workspace roles (Review 2+). Review 1 uses a
 * single-owner model, so these are intentionally unused for now but reserved to keep
 * the eventual authorization layer's vocabulary in one place.
 */
export const WORKSPACE_ROLES = {
  OWNER: 'OWNER',
} as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[keyof typeof WORKSPACE_ROLES];
