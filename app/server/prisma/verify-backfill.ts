/**
 * RBAC backfill verification (Checkpoint 3.5).
 *
 * Proves the migrated `WorkspaceMember` rows exactly mirror the legacy `ownerId` model
 * before any route starts trusting memberships. Read-only; exits non-zero on any drift so
 * it can gate a deploy or be run in CI against a staging database.
 *
 * Run with `npm run verify:rbac` (or `npx tsx prisma/verify-backfill.ts`).
 */
import prisma from '../src/config/database.js';
import { logger } from '../src/config/logger.js';

interface Report {
  workspaces: number;
  memberships: number;
  missingOwnerMembership: string[];
  ownerRoleMismatch: string[];
  membershipWithoutOwner: string[];
}

const collect = async (): Promise<Report> => {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, ownerId: true, members: { select: { userId: true, role: true } } },
  });

  const missingOwnerMembership: string[] = [];
  const ownerRoleMismatch: string[] = [];
  let membershipCount = 0;

  for (const workspace of workspaces) {
    membershipCount += workspace.members.length;

    const ownerMember = workspace.members.find((m) => m.userId === workspace.ownerId);
    if (!ownerMember) {
      missingOwnerMembership.push(workspace.id);
    } else if (ownerMember.role !== 'OWNER') {
      ownerRoleMismatch.push(workspace.id);
    }
  }

  // A membership whose user is not the workspace owner would be an unexpected extra row.
  const membershipWithoutOwner = workspaces.flatMap((workspace) =>
    workspace.members
      .filter((m) => m.userId !== workspace.ownerId)
      .map((m) => `${workspace.id}:${m.userId}`)
  );

  return {
    workspaces: workspaces.length,
    memberships: membershipCount,
    missingOwnerMembership,
    ownerRoleMismatch,
    membershipWithoutOwner,
  };
};

const main = async (): Promise<void> => {
  const report = await collect();
  logger.info(report, 'RBAC backfill verification report');

  const failures =
    report.missingOwnerMembership.length +
    report.ownerRoleMismatch.length +
    report.membershipWithoutOwner.length;

  if (failures > 0) {
    logger.error(
      'RBAC backfill does NOT match the ownerId model — do not enable RBAC enforcement.'
    );
    process.exitCode = 1;
    return;
  }

  logger.info(
    `OK: ${report.memberships} memberships across ${report.workspaces} workspaces all match ownerId`
  );
};

main()
  .catch((err) => {
    logger.error({ err }, 'RBAC backfill verification failed to run');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
