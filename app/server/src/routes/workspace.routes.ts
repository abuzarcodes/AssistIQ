import { Router } from 'express';
import { validate } from '../middleware/validation.middleware.js';
import { requireWorkspacePermission } from '../middleware/authorization.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { createWorkspaceSchema, workspaceIdParamSchema } from '../schemas/workspace.schema.js';
import * as workspaceController from '../controllers/workspace.controller.js';
import { botCreateListRouter } from './bot.routes.js';
import { workspaceMemberRouter } from './workspaceMember.routes.js';

const router = Router();

// Collection-level routes have no workspace scope to check: creating a workspace makes the
// caller its OWNER, and listing is filtered to the caller's memberships in the service.
router.post('/', validate({ body: createWorkspaceSchema }), workspaceController.createWorkspace);
router.get('/', workspaceController.listWorkspaces);

router.get(
  '/:workspaceId',
  validate({ params: workspaceIdParamSchema }),
  requireWorkspacePermission(PERMISSIONS.WORKSPACE_VIEW),
  workspaceController.getWorkspace
);

// Member management (members:view / members:manage enforced inside).
router.use('/:workspaceId/members', workspaceMemberRouter);

// Bots are created and listed within the context of a workspace.
router.use('/:workspaceId/bots', botCreateListRouter);

export default router;
