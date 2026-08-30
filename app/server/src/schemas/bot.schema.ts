import { z } from 'zod';

export const createBotSchema = z.object({
  name: z.string().trim().min(1, 'Bot name is required').max(120),
  description: z.string().trim().max(2000).optional(),
});

export const updateBotSchema = z
  .object({
    name: z.string().trim().min(1, 'Bot name cannot be empty').max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: 'Provide at least one field to update (name or description)',
  });

export const botIdParamSchema = z.object({
  botId: z.string().uuid('Invalid bot id'),
});

export type CreateBotInput = z.infer<typeof createBotSchema>;
export type UpdateBotInput = z.infer<typeof updateBotSchema>;
