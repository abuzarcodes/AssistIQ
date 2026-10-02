import { z } from 'zod';

/** The three workspace membership roles (mirrors the Prisma `WorkspaceRole` enum). */
export const workspaceRoleSchema = z.enum(['OWNER', 'ADMIN', 'AGENT']);

export const addMemberSchema = z.object({
  // Normalised so the lookup is case-insensitive in practice.
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  role: workspaceRoleSchema,
});

export const updateMemberRoleSchema = z.object({
  role: workspaceRoleSchema,
});

export const memberParamsSchema = z.object({
  workspaceId: z.string().uuid('Invalid workspace id'),
  memberId: z.string().uuid('Invalid member id'),
});

export const membersListParamsSchema = z.object({
  workspaceId: z.string().uuid('Invalid workspace id'),
});

export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
