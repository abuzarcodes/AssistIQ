import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { createWorkspaceSchema, workspaceIdParamSchema } from '../schemas/workspace.schema.js';
import * as workspaceController from '../controllers/workspace.controller.js';
import { botCreateListRouter } from './bot.routes.js';

const router = Router();

router.post('/', validate({ body: createWorkspaceSchema }), workspaceController.createWorkspace);
router.get('/', workspaceController.listWorkspaces);
router.get(
  '/:workspaceId',
  validate({ params: workspaceIdParamSchema }),
  workspaceController.getWorkspace
);

// Bots are created and listed within the context of a workspace.
router.use('/:workspaceId/bots', botCreateListRouter);

export default router;
