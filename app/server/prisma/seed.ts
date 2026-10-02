/**
 * RBAC + AI catalog seed.
 *
 * Idempotent jobs:
 *   1. Backfill a `WorkspaceMember(role = OWNER)` for every existing workspace's `ownerId`,
 *      mirroring the pre-RBAC single-owner model into explicit membership rows.
 *   2. Promote the user named by `PLATFORM_OWNER_EMAIL` to `PLATFORM_OWNER` (no-op with a
 *      warning when the variable is unset or the user does not exist yet).
 *   3. Backfill the AI model catalog (`AIProvider` / `AIModel`) with every row **disabled**.
 *
 * Safe to run repeatedly: the backfill uses `skipDuplicates`, the promotion is a no-op
 * once applied, and the catalog upserts only insert absent rows. Run with
 * `npm run db:seed` (or `npx prisma db seed`).
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

/**
 * Starter catalog (Checkpoint 1). Providers are seeded rather than created through the API
 * because a provider row is meaningful only once a Python adapter for its `slug` exists.
 *
 * Every row is seeded `enabled: false` — the seed must never change platform behaviour on
 * its own; each switch is thrown deliberately by a platform owner in the UI.
 *
 * `providerModelId` values are OpenRouter-native ids and MUST be verified against
 * OpenRouter's live model list before being enabled. A wrong id surfaces at chat time as
 * `MODEL_UNAVAILABLE`; because the field is immutable the fix is delete-and-recreate, which
 * is safe for a never-enabled model because no bot can reference it yet.
 */
const STARTER_CATALOG: ReadonlyArray<{
  provider: { slug: string; name: string; description: string };
  models: ReadonlyArray<{ providerModelId: string; displayName: string }>;
}> = [
  {
    provider: {
      slug: 'openrouter',
      name: 'OpenRouter',
      description: 'Multi-vendor model gateway (OpenAI-compatible).',
    },
    models: [
      { providerModelId: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini' },
      { providerModelId: 'anthropic/claude-sonnet-4', displayName: 'Claude Sonnet 4' },
      { providerModelId: 'google/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
    ],
  },
];

/**
 * Backfill the AI catalog. This is a **backfill for absent rows**, not a reconciler: the
 * upserts carry no `update` clause, so an existing row is left exactly as the operator has
 * it — a re-run never flips an `enabled` choice back, nor resurrects a model an operator
 * deliberately deleted. Returns the number of rows actually created.
 */
const seedAiCatalog = async (): Promise<{ providers: number; models: number }> => {
  let providers = 0;
  let models = 0;

  for (const entry of STARTER_CATALOG) {
    const existing = await prisma.aIProvider.findUnique({
      where: { slug: entry.provider.slug },
      select: { id: true },
    });

    const provider =
      existing ??
      (await prisma.aIProvider.create({
        data: { ...entry.provider, enabled: false },
        select: { id: true },
      }));

    if (!existing) {
      providers += 1;
    }

    for (const model of entry.models) {
      // Deliberately a presence check rather than an `upsert` whose `update` clause would
      // reassert the seed's intent over the operator's: a backfill must be able to report
      // "created none" on a re-run *and* leave existing rows untouched.
      const before = await prisma.aIModel.findUnique({
        where: {
          providerId_providerModelId: {
            providerId: provider.id,
            providerModelId: model.providerModelId,
          },
        },
        select: { id: true },
      });

      if (before) {
        continue;
      }

      await prisma.aIModel.create({
        data: {
          providerId: provider.id,
          providerModelId: model.providerModelId,
          displayName: model.displayName,
          enabled: false,
        },
      });
      models += 1;
    }
  }

  logger.info({ providers, models }, 'Backfilled AI model catalog (all rows disabled)');
  return { providers, models };
};

const main = async (): Promise<void> => {
  const created = await backfillWorkspaceOwners();
  logger.info({ created }, 'Backfilled workspace owner memberships');

  await promotePlatformOwner();

  await seedAiCatalog();
};

main()
  .catch((err) => {
    logger.error({ err }, 'RBAC seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
