import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import * as platformController from '../controllers/platform.controller.js';
import * as aiCatalogController from '../controllers/aiCatalog.controller.js';
import {
  createModelSchema,
  listModelsQuerySchema,
  modelIdParamSchema,
  providerIdParamSchema,
  updateModelSchema,
  updateProviderSchema,
} from '../schemas/aiCatalog.schema.js';
import { updateSettingsSchema } from '../schemas/platformSettings.schema.js';

/**
 * Platform admin API, mounted at /platform and gated by `authenticate` +
 * `requirePlatformOwner()` in routes/index.ts.
 *
 * `GET /platform/system` is the platform-level system view; the AI Lab tooling itself
 * stays under /admin/ai (also platform-owner-only) so existing clients keep working.
 *
 * The `/providers` and `/models` routes below are the AI catalog (Checkpoint 2). They
 * carry **no route-level guard** — the namespace guard above is the correct and only place
 * for it, so a future route added here cannot accidentally ship unguarded. They make no
 * provider-bound network request: v1 measures no live reachability (see "Provider
 * readiness: three independent axes").
 */
const router = Router();

router.get('/users', platformController.listUsers);
router.get('/workspaces', platformController.listWorkspaces);
router.get('/system', platformController.getSystemStatus);

// --- Upload limits (section 12.9) ---
//
// No route-level guard, for the same reason as the catalog routes below: the namespace
// guard in routes/index.ts is the single place the platform-owner check belongs, so a
// route added here cannot accidentally ship unguarded.
//
// This is the write path for the limits every upload enforces. `updateSettingsSchema`
// bounds each field and `settingsInvariantsSchema` (applied by the service, on the merged
// result) rejects a self-contradictory combination.
router.get('/settings', platformController.getSettings);
router.patch(
  '/settings',
  validate({ body: updateSettingsSchema }),
  platformController.updateSettings
);

// --- AI catalog (platform-owner only via the namespace guard) ---

router.get('/providers', aiCatalogController.listProviders);
router.patch(
  '/providers/:providerId',
  validate({ params: providerIdParamSchema, body: updateProviderSchema }),
  aiCatalogController.updateProvider
);

router.get('/models', validate({ query: listModelsQuerySchema }), aiCatalogController.listModels);
router.post('/models', validate({ body: createModelSchema }), aiCatalogController.createModel);
router.patch(
  '/models/:modelId',
  validate({ params: modelIdParamSchema, body: updateModelSchema }),
  aiCatalogController.updateModel
);
router.delete(
  '/models/:modelId',
  validate({ params: modelIdParamSchema }),
  aiCatalogController.deleteModel
);

export default router;
