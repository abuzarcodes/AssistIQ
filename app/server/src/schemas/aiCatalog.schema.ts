import { z } from 'zod';

/**
 * Validation schemas for the platform-owned AI catalog (Checkpoint 2).
 *
 * Two rules here are security-relevant rather than cosmetic:
 *
 *  1. **Identity fields are rejected, not stripped.** `providerModelId` (on models) and
 *     `slug` (on providers) bind a catalog row to a code artefact — a Python adapter, and
 *     the provider-native id an already-assigned bot would call. `updateModelSchema` and
 *     `updateProviderSchema` are `.strict()`, so a body carrying either field fails
 *     validation with a **400**. Silently dropping it would return a `200` that misleads
 *     the client about what the system will actually call.
 *  2. **Creation is the only write path for `providerModelId`.** It is set once, in
 *     `createModelSchema`, and never accepted again.
 *
 * Note on query params: `validation.middleware.ts` validates `req.query` in place without
 * reassigning it (Express's query accessor is a getter), so a `.transform()` here would be
 * discarded. `listModelsQuerySchema` therefore only *validates* the string form and the
 * controller converts `'true'`/`'false'` to a boolean.
 */

export const providerIdParamSchema = z.object({
  providerId: z.string().uuid('Invalid provider id'),
});

export const modelIdParamSchema = z.object({
  modelId: z.string().uuid('Invalid model id'),
});

export const listModelsQuerySchema = z.object({
  providerId: z.string().uuid('Invalid provider id').optional(),
  enabled: z.enum(['true', 'false'], { message: 'enabled must be true or false' }).optional(),
});

/**
 * Add a model to the catalog. `providerModelId` is the provider-native identifier, passed
 * verbatim to the provider API — trimmed, non-empty, and whitespace-free because an id
 * containing a space is always a paste error, and it would only surface much later as an
 * opaque `MODEL_UNAVAILABLE` at chat time.
 */
export const createModelSchema = z.object({
  providerId: z.string().uuid('Invalid provider id'),
  providerModelId: z
    .string()
    .trim()
    .min(1, 'Provider model id is required')
    .max(200)
    .refine((value) => !/\s/.test(value), { message: 'Provider model id cannot contain whitespace' }),
  displayName: z.string().trim().min(1, 'Display name is required').max(120),
  // A newly catalogued model is NOT selectable until a platform owner deliberately enables
  // it. Defaulting to `true` would let a create request change platform behaviour.
  enabled: z.boolean().optional().default(false),
});

/**
 * Edit a model. `providerModelId` is immutable and is therefore absent from this schema —
 * combined with `.strict()`, any attempt to send it is a 400.
 *
 * Correcting a wrong `providerModelId` is a delete-and-recreate. That is safe precisely
 * because deletion is blocked while any bot references the model: a model that is in use
 * cannot have its identity changed at all, and an unused one can be corrected freely.
 */
export const updateModelSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Display name cannot be empty').max(120).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((data) => data.displayName !== undefined || data.enabled !== undefined, {
    message: 'Provide at least one field to update (displayName or enabled)',
  });

/** Edit a provider. `slug` is absent and `.strict()` rejects it — see the file header. */
export const updateProviderSchema = z
  .object({
    name: z.string().trim().min(1, 'Provider name cannot be empty').max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((data) => data.name !== undefined || data.description !== undefined || data.enabled !== undefined, {
    message: 'Provide at least one field to update (name, description or enabled)',
  });

export type CreateModelInput = z.infer<typeof createModelSchema>;
export type UpdateModelInput = z.infer<typeof updateModelSchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;
export type ListModelsQuery = z.infer<typeof listModelsQuerySchema>;
