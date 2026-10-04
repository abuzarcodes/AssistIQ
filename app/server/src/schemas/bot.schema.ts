import { z } from 'zod';

export const createBotSchema = z.object({
  name: z.string().trim().min(1, 'Bot name is required').max(120),
  description: z.string().trim().max(2000).optional(),
});

/**
 * Update a bot's identity, or pause/resume it (§10.2).
 *
 * `isActive` is the pause switch. It lives on the bot rather than on its configuration
 * because it is *operational state*, not presentation: a paused bot still has a name, a
 * personality and a knowledge base, and pausing one must not touch any of them.
 */
export const updateBotSchema = z
  .object({
    name: z.string().trim().min(1, 'Bot name cannot be empty').max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined || data.description !== undefined || data.isActive !== undefined,
    { message: 'Provide at least one field to update (name, description or isActive)' }
  );

export const botIdParamSchema = z.object({
  botId: z.string().uuid('Invalid bot id'),
});

/**
 * Assign (or clear) a bot's catalog models — the primary and the failover (§10.3).
 *
 * Both fields are the **internal catalog uuid**, never a provider-native id. That is
 * enforced here by the uuid check rather than in the service: a body carrying
 * `"openai/gpt-4o-mini"` — or any other value a client might hope will bypass the catalog —
 * fails validation with a 400 before a handler ever runs. Node remains the sole catalog
 * authority.
 *
 * `null` is a first-class value meaning "follow the platform default model", not an
 * omission: it is how a bot is returned to the default at any time, and how the whole
 * feature is rolled back.
 *
 * Backward compatible by construction: every existing client sends `aiModelId`, which still
 * validates, and the two `.refine`s below are satisfied by that body alone.
 */
export const assignModelSchema = z
  .object({
    aiModelId: z.string().uuid('Invalid model id').nullable().optional(),
    fallbackAiModelId: z.string().uuid('Invalid fallback model id').nullable().optional(),
  })
  .refine((data) => data.aiModelId !== undefined || data.fallbackAiModelId !== undefined, {
    // A missing key is an incomplete request, not a clear — treating `{}` as "unassign
    // everything" would wipe a bot's model on a malformed call. `null` is how you clear.
    message: 'Provide at least one model field to update',
  })
  .refine(
    (data) =>
      data.aiModelId === undefined ||
      data.fallbackAiModelId === undefined ||
      data.aiModelId !== data.fallbackAiModelId,
    {
      // Only the *partial* case is checkable here. When just one field is sent, the conflict
      // can only be found against the stored other field, so the service checks again after
      // the membership gate — which is also what keeps the 400/404 ordering intact.
      message: 'The fallback model must differ from the primary model',
      path: ['fallbackAiModelId'],
    }
  );

export type CreateBotInput = z.infer<typeof createBotSchema>;
export type UpdateBotInput = z.infer<typeof updateBotSchema>;
export type AssignModelInput = z.infer<typeof assignModelSchema>;
