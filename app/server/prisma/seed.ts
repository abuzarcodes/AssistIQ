/**
 * RBAC data migration / seed (Checkpoint 2).
 *
 * Two idempotent jobs:
 *   1. Backfill a `WorkspaceMember(role = OWNER)` for every existing workspace's `ownerId`,
 *      mirroring the pre-RBAC single-owner model into explicit membership rows.
 *   2. Promote the user named by `PLATFORM_OWNER_EMAIL` to `PLATFORM_OWNER` (no-op with a
 *      warning when the variable is unset or the user does not exist yet).
 *
 * Safe to run repeatedly: the backfill uses `skipDuplicates` and the promotion is a
 * no-op once applied. Run with `npm run db:seed` (or `npx prisma db seed`).
 */
import prisma from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { logger } from '../src/config/logger.js';

const backfillWorkspaceOwners = async (): Promise<number> => {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, ownerId: true },
  });

  if (workspaces.length === 0) {
    return 0;
  }

  const { count } = await prisma.workspaceMember.createMany({
    data: workspaces.map((workspace) => ({
      workspaceId: workspace.id,
      userId: workspace.ownerId,
      role: 'OWNER',
    })),
    // Mirrors the plan's `ON CONFLICT (user_id, workspace_id) DO NOTHING` — never
    // clobbers an existing membership, so the script is idempotent.
    skipDuplicates: true,
  });

  return count;
};

const promotePlatformOwner = async (): Promise<void> => {
  const email = env.PLATFORM_OWNER_EMAIL?.trim();
  if (!email) {
    logger.warn('PLATFORM_OWNER_EMAIL is not set — skipping platform owner promotion');
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Register the account first, then re-run the seed. Not an error: keeps the seed
    // usable in a fresh environment before anyone has signed up.
    logger.warn({ email }, 'PLATFORM_OWNER_EMAIL does not match any user — skipping promotion');
    return;
  }

  if (user.platformRole === 'PLATFORM_OWNER') {
    logger.info({ email }, 'User is already a PLATFORM_OWNER — nothing to do');
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { platformRole: 'PLATFORM_OWNER' },
  });
  logger.info({ email }, 'Promoted user to PLATFORM_OWNER');
};

const main = async (): Promise<void> => {
  const created = await backfillWorkspaceOwners();
  logger.info({ created }, 'Backfilled workspace owner memberships');

  await promotePlatformOwner();
};

main()
  .catch((err) => {
    logger.error({ err }, 'RBAC seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
