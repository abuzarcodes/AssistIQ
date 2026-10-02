import { Router } from 'express';
import * as platformController from '../controllers/platform.controller.js';

/**
 * Platform admin API, mounted at /platform and gated by `authenticate` +
 * `requirePlatformOwner()` in routes/index.ts.
 *
 * `GET /platform/system` is the platform-level system view; the AI Lab tooling itself
 * stays under /admin/ai (also platform-owner-only) so existing clients keep working.
 */
const router = Router();

router.get('/users', platformController.listUsers);
router.get('/workspaces', platformController.listWorkspaces);
router.get('/system', platformController.getSystemStatus);

export default router;
