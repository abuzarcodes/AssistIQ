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

/**
 * Assign (or clear) a bot's catalog model (Checkpoint 3).
 *
 * `aiModelId` must be the **internal catalog uuid**, never a provider-native id. That is
 * enforced here by the uuid check rather than in the service: a body carrying
 * `"openai/gpt-4o-mini"` — or any other value a client might hope will bypass the catalog —
 * fails validation with a 400 before a handler ever runs. Node remains the sole catalog
 * authority.
 *
 * `null` is a first-class value meaning "follow the platform default model", not an
 * omission: it is how a bot is returned to the default at any time, and how the whole
 * feature is rolled back.
 */
export const assignModelSchema = z.object({
  aiModelId: z.string().uuid('Invalid model id').nullable(),
});

export type CreateBotInput = z.infer<typeof createBotSchema>;
export type UpdateBotInput = z.infer<typeof updateBotSchema>;
export type AssignModelInput = z.infer<typeof assignModelSchema>;
