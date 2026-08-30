import { z } from 'zod';

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, 'Workspace name is required').max(120),
});

export const workspaceIdParamSchema = z.object({
  workspaceId: z.string().uuid('Invalid workspace id'),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
