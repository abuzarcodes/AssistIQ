import { Router } from 'express';
import * as aiCatalogController from '../controllers/aiCatalog.controller.js';

/**
 * Workspace-facing AI catalog, mounted at `/ai` behind `authenticate` only (Checkpoint 3).
 *
 * **Why no permission gate beyond authentication.** The catalog of *enabled* models is not
 * tenant data: it is the same list for every caller, it contains nothing about any
 * workspace, bot, or user, and it is exactly what a client needs in order to render a model
 * selector. Requiring a workspace permission would also be impossible to express here — this
 * route carries no workspace id, and the permission middleware would have no scope to
 * resolve. The authorization that matters is on the *write* path
 * (`PATCH /bots/:botId/model`, gated on `bots:manage`), not on reading the list of
 * options.
 *
 * The projection is fixed by `listSelectableModels`: `{ id, displayName, provider }`, with
 * `providerModelId` deliberately absent.
 */
const router = Router();

router.get('/models', aiCatalogController.listSelectableModels);

export default router;
