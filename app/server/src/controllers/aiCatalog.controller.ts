import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { logger } from '../config/logger.js';
import * as aiCatalogService from '../services/aiCatalog.service.js';
import type { CreateModelInput, UpdateModelInput, UpdateProviderInput } from '../schemas/aiCatalog.schema.js';

/**
 * Platform-owner AI catalog management (Checkpoint 2), plus the workspace-facing catalog
 * read (Checkpoint 3).
 *
 * The /platform routes are mounted behind `authenticate` + `requirePlatformOwner()` in
 * routes/index.ts. Handlers therefore assume a verified PLATFORM_OWNER and contain **no
 * role logic** — matching the documented convention in platform.controller.ts.
 *
 * `listSelectableModels` is mounted at `/ai` behind authentication only; see
 * routes/aiCatalog.routes.ts for why the list itself needs no workspace permission.
 */

/**
 * The interim attribution control for catalog changes (Security Requirement S10).
 *
 * A catalog change alters what every tenant can select, so it has to be answerable to
 * "who did this?". v1 has no audit table and no audit endpoint — that is a deliberate
 * decision (D21), not an omission — so this log record *is* the whole of the trail.
 *
 * **Why the controller.** It is the only layer that knows the actor. The service owns the
 * target and the resulting state but is deliberately actor-agnostic; threading a user id
 * through its signatures would couple data access to whichever request happened to trigger
 * it, and would put the log line where a future second caller silently loses attribution.
 *
 * **Why one record per mutation, rather than only enable/disable/delete.** S10 enumerates
 * those three; a rule with an unstated exception is a rule the next person gets wrong. A
 * create changes platform behaviour exactly as much as an enable does, so every successful
 * mutation logs, and "exactly one record per catalog change" is a claim a test can hold.
 *
 * The record carries no credential and no provider-native id — only the catalog's own uuid,
 * which is what a durable audit table would reference anyway.
 */
type CatalogAction =
  | 'provider.enabled'
  | 'provider.disabled'
  | 'provider.updated'
  | 'model.created'
  | 'model.enabled'
  | 'model.disabled'
  | 'model.updated'
  | 'model.deleted';

const logCatalogChange = (
  actorId: string | undefined,
  action: CatalogAction,
  targetId: string,
  state: Record<string, unknown> = {}
): void => {
  logger.info({ actorId, action, targetId, ...state }, 'ai catalog change');
};

/** An update that turned a flag on or off names what happened; anything else is a plain edit. */
const flagAction = <T extends 'provider' | 'model'>(
  entity: T,
  requested: boolean | undefined,
  result: boolean
): CatalogAction =>
  requested === undefined
    ? (`${entity}.updated` as CatalogAction)
    : result
      ? (`${entity}.enabled` as CatalogAction)
      : (`${entity}.disabled` as CatalogAction);

export const listProviders = asyncHandler(async (_req: Request, res: Response) => {
  const providers = await aiCatalogService.listProviders();
  sendSuccess(res, providers, 'Providers retrieved', 200);
});

export const updateProvider = asyncHandler(async (req: Request, res: Response) => {
  const provider = await aiCatalogService.updateProvider(
    req.params.providerId!,
    req.body as UpdateProviderInput
  );
  logCatalogChange(req.user?.id, flagAction('provider', (req.body as UpdateProviderInput).enabled, provider.enabled), provider.id, {
    slug: provider.slug,
    enabled: provider.enabled,
  });
  sendSuccess(res, provider, 'Provider updated', 200);
});

export const listModels = asyncHandler(async (req: Request, res: Response) => {
  // `validate` checks req.query in place rather than reassigning it, so the coercion from
  // the string form happens here — see aiCatalog.schema.ts.
  const enabled = req.query.enabled;
  const models = await aiCatalogService.listModels({
    providerId: typeof req.query.providerId === 'string' ? req.query.providerId : undefined,
    enabled: enabled === 'true' ? true : enabled === 'false' ? false : undefined,
  });
  sendSuccess(res, models, 'Models retrieved', 200);
});

export const createModel = asyncHandler(async (req: Request, res: Response) => {
  const model = await aiCatalogService.createModel(req.body as CreateModelInput);
  logCatalogChange(req.user?.id, 'model.created', model.id, {
    providerId: model.providerId,
    enabled: model.enabled,
  });
  sendSuccess(res, model, 'Model created', 201);
});

export const updateModel = asyncHandler(async (req: Request, res: Response) => {
  const model = await aiCatalogService.updateModel(req.params.modelId!, req.body as UpdateModelInput);
  logCatalogChange(req.user?.id, flagAction('model', (req.body as UpdateModelInput).enabled, model.enabled), model.id, {
    providerId: model.providerId,
    enabled: model.enabled,
  });
  sendSuccess(res, model, 'Model updated', 200);
});

export const deleteModel = asyncHandler(async (req: Request, res: Response) => {
  const deleted = await aiCatalogService.deleteModel(req.params.modelId!);
  // The row is gone after this, so the *log* is the only place its label survives. That is
  // the point of logging the snapshot rather than just the id.
  logCatalogChange(req.user?.id, 'model.deleted', deleted.id, {
    providerId: deleted.providerId,
    displayName: deleted.displayName,
    enabled: deleted.enabled,
  });
  sendSuccess(res, null, 'Model deleted', 200);
});

/** The workspace-facing read: enabled models of enabled providers, without provider ids. */
export const listSelectableModels = asyncHandler(async (_req: Request, res: Response) => {
  const models = await aiCatalogService.listSelectableModels();
  sendSuccess(res, models, 'Models retrieved', 200);
});
