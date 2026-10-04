import prisma from '../config/database.js';
import { aiServiceClient } from './aiServiceClient.js';
import { logger } from '../config/logger.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { resolveCapabilities } from '../constants/modelCapabilities.js';
import type { ModelCapabilities } from '../types/botConfig.types.js';
import type { CreateModelInput, UpdateModelInput, UpdateProviderInput } from '../schemas/aiCatalog.schema.js';

/**
 * AI catalog data access for the platform-owner API (Checkpoint 2).
 *
 * Global, cross-tenant reads and writes — deliberately NOT scoped by membership, exactly
 * like `platform.service.ts`. They are reachable only through `requirePlatformOwner()`.
 *
 * **Nothing in this file contacts a provider**, and no response contains a credential.
 * Readiness is reported as two independent booleans sourced from the AI service's own
 * configuration report; live reachability is deliberately not measured (see "Provider
 * readiness: three independent axes" in the plan).
 */

/** Readiness for one provider slug, as reported by the AI service. */
interface ProviderReadiness {
  /** Axis 1 — a Python adapter is registered for this slug. */
  adapterAvailable: boolean;
  /** Axis 2 — the adapter reports its credential is present. `null` when there is no adapter. */
  credentialConfigured: boolean | null;
}

/**
 * Ask the AI service which adapters it has and whether each is configured.
 *
 * Returns `null` — meaning "unknown", not "unavailable" — when the AI service is
 * unreachable **or** when it does not report `provider_adapters` at all. That second case
 * is real: this endpoint lands in Checkpoint 2, while the `provider_adapters` field it
 * reads is added in Checkpoint 5. Reporting `false` in that window would be an affirmative
 * claim ("no adapter is registered") that this code cannot actually make.
 *
 * Mirrors the swallow-and-report pattern in `platform.service.getSystemStatus`: a down AI
 * service degrades the *readiness columns*, never the provider list itself.
 */
const loadProviderReadiness = async (): Promise<Map<string, ProviderReadiness> | null> => {
  try {
    const status = (await aiServiceClient.getAiStatus()) as {
      provider_adapters?: Array<{ slug?: unknown; configured?: unknown }>;
    };

    if (!Array.isArray(status?.provider_adapters)) {
      return null;
    }

    const map = new Map<string, ProviderReadiness>();
    for (const adapter of status.provider_adapters) {
      if (typeof adapter?.slug !== 'string') continue;
      map.set(adapter.slug, {
        adapterAvailable: true,
        credentialConfigured: adapter.configured === true,
      });
    }
    return map;
  } catch (err) {
    logger.warn({ err }, 'AI service unreachable during provider readiness check — reporting unknown');
    return null;
  }
};

/** A provider row with its derived counts and readiness. */
export interface ProviderView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  modelCount: number;
  enabledModelCount: number;
  adapterAvailable: boolean | null;
  credentialConfigured: boolean | null;
}

const providerSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
  // Selecting the flag rather than using a filtered `_count` keeps the total and the
  // enabled count in one query without depending on a filtered-count feature.
  models: { select: { enabled: true } },
} as const;

type ProviderRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  models: Array<{ enabled: boolean }>;
};

/**
 * Turn a provider row into its API shape.
 *
 * When the AI service is unreachable, both readiness fields are `null` together — the list
 * must still render, showing a neutral "status unknown" state. When it *is* reachable, a
 * slug it does not report has `adapterAvailable: false` (an accurate, actionable answer:
 * deploy an adapter) and `credentialConfigured: null` (there is no adapter whose credential
 * could be checked, so the question is unanswerable rather than answered "no").
 */
const toProviderView = (
  { models, ...provider }: ProviderRow,
  readiness: Map<string, ProviderReadiness> | null
): ProviderView => {
  const entry = readiness?.get(provider.slug);

  return {
    ...provider,
    modelCount: models.length,
    enabledModelCount: models.filter((model) => model.enabled).length,
    adapterAvailable: readiness === null ? null : entry !== undefined,
    credentialConfigured: readiness === null ? null : (entry?.credentialConfigured ?? null),
  };
};

/**
 * Every provider with model counts and readiness. Counts are derived from the relation
 * rather than stored, so there is no counter to drift.
 */
export const listProviders = async (): Promise<ProviderView[]> => {
  const [providers, readiness] = await Promise.all([
    prisma.aIProvider.findMany({ select: providerSelect, orderBy: { name: 'asc' } }),
    loadProviderReadiness(),
  ]);

  return providers.map((provider) => toProviderView(provider, readiness));
};

/**
 * Enable/disable a provider and edit its label.
 *
 * Disabling does **not** touch its models — this is a single-flag update on the provider
 * row, so it cannot race a concurrent model edit (Concurrency R4). Resolution simply stops
 * accepting the provider's models; no row changes.
 */
export const updateProvider = async (
  providerId: string,
  input: UpdateProviderInput
): Promise<ProviderView> => {
  const existing = await prisma.aIProvider.findUnique({
    where: { id: providerId },
    select: { id: true },
  });
  if (!existing) {
    throw new NotFoundError('Provider not found');
  }

  const [updated, readiness] = await Promise.all([
    prisma.aIProvider.update({
      where: { id: providerId },
      data: {
        name: input.name,
        description: input.description,
        enabled: input.enabled,
      },
      select: providerSelect,
    }),
    loadProviderReadiness(),
  ]);

  return toProviderView(updated, readiness);
};

/** A model row with its provider summary and live bot-use count. */
export interface ModelView {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  provider: { id: string; slug: string; name: string; enabled: boolean };
  botCount: number;
}

const modelInclude = {
  provider: { select: { id: true, slug: true, name: true, enabled: true } },
  // `botCount` is always a live count, never a stored counter, so it cannot drift from
  // the rows that actually reference the model.
  _count: { select: { bots: true } },
} as const;

type ModelRow = {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  provider: { id: string; slug: string; name: string; enabled: boolean };
  _count: { bots: number };
};

const toModelView = ({ _count, ...model }: ModelRow): ModelView => ({
  ...model,
  botCount: _count.bots,
});

/** Every catalogued model (any state), optionally filtered by provider and enabled flag. */
export const listModels = async (filters: {
  providerId?: string;
  enabled?: boolean;
}): Promise<ModelView[]> => {
  const rows = await prisma.aIModel.findMany({
    where: {
      ...(filters.providerId ? { providerId: filters.providerId } : {}),
      ...(filters.enabled === undefined ? {} : { enabled: filters.enabled }),
    },
    include: modelInclude,
    orderBy: [{ provider: { name: 'asc' } }, { displayName: 'asc' }],
  });

  return rows.map(toModelView);
};

/**
 * Add a model to the catalog. This is the **only** request in the API that writes
 * `providerModelId`, and it writes it once.
 *
 * A duplicate `(providerId, providerModelId)` is a 409 rather than a silent update: the
 * only correction path for a wrong id is delete-and-recreate, so a client re-POSTing a
 * "fixed" id is told plainly that the row already exists instead of ending up with two
 * near-identical models.
 *
 * A wrong `providerModelId` is **not** detectable here — Node holds no provider credential
 * and makes no live provider calls — so the value is stored as supplied and surfaces at
 * chat time as `MODEL_UNAVAILABLE`.
 */
export const createModel = async (input: CreateModelInput): Promise<ModelView> => {
  const provider = await prisma.aIProvider.findUnique({
    where: { id: input.providerId },
    select: { id: true },
  });
  if (!provider) {
    throw new NotFoundError('Provider not found');
  }

  const duplicate = await prisma.aIModel.findUnique({
    where: {
      providerId_providerModelId: {
        providerId: input.providerId,
        providerModelId: input.providerModelId,
      },
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new ConflictError('That provider model id is already in the catalog');
  }

  const created = await prisma.aIModel.create({
    data: {
      providerId: input.providerId,
      providerModelId: input.providerModelId,
      displayName: input.displayName,
      enabled: input.enabled,
    },
    include: modelInclude,
  });

  return toModelView(created);
};

/**
 * Edit a model's label or enabled flag. The schema has already rejected any attempt to
 * change `providerModelId` with a 400 — it is immutable after creation.
 */
export const updateModel = async (modelId: string, input: UpdateModelInput): Promise<ModelView> => {
  const existing = await prisma.aIModel.findUnique({
    where: { id: modelId },
    select: { id: true },
  });
  if (!existing) {
    throw new NotFoundError('Model not found');
  }

  const updated = await prisma.aIModel.update({
    where: { id: modelId },
    data: { displayName: input.displayName, enabled: input.enabled },
    include: modelInclude,
  });

  return toModelView(updated);
};

/**
 * What survives a deletion, for the caller to attribute it to.
 *
 * Returned rather than discarded because the row itself is about to stop existing: the
 * controller's log record is the only remaining trace of what was removed (S10).
 * `providerModelId` is deliberately not included — a deleted model's identity in the
 * catalog is its uuid, and the provider-native id is not needed to answer "who removed what".
 */
export interface DeletedModel {
  id: string;
  providerId: string;
  displayName: string;
  enabled: boolean;
}

/**
 * Delete a model — permitted only while no bot references it.
 *
 * The `botCount` check runs first so the operator gets an actionable message; the
 * `onDelete: Restrict` foreign key is the actual guarantee, holding even if this check is
 * bypassed, raced, or removed by a future edit (Concurrency R3). Prisma's `P2003` is
 * translated to the same 409 so a race between the check and the delete cannot surface as
 * an opaque 500.
 */
export const deleteModel = async (modelId: string): Promise<DeletedModel> => {
  const model = await prisma.aIModel.findUnique({
    where: { id: modelId },
    select: {
      id: true,
      providerId: true,
      displayName: true,
      enabled: true,
      _count: { select: { bots: true } },
    },
  });
  if (!model) {
    throw new NotFoundError('Model not found');
  }

  if (model._count.bots > 0) {
    throw new ConflictError(
      `This model is assigned to ${model._count.bots} bot(s). Reassign them before deleting.`
    );
  }

  try {
    await prisma.aIModel.delete({ where: { id: modelId } });
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new ConflictError('This model is assigned to one or more bots. Reassign them before deleting.');
    }
    throw err;
  }

  return {
    id: model.id,
    providerId: model.providerId,
    displayName: model.displayName,
    enabled: model.enabled,
  };
};

/** Prisma's foreign-key-violation code, raised by the `Restrict` constraint. */
const isForeignKeyViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2003';

/** A catalog entry as a workspace sees it — identity, provider label, and capabilities. */
export interface SelectableModel {
  id: string;
  displayName: string;
  provider: { slug: string; name: string };
  capabilities: ModelCapabilities;
}

/**
 * The catalog as **workspaces** see it (Checkpoint 3): enabled models of enabled providers.
 *
 * Deliberately omits `providerModelId`. The workspace selects by internal uuid; the
 * provider-native id is an implementation detail, and returning it would invite a client to
 * attempt to use it directly — precisely the catalog bypass the API is built to prevent.
 * This projection is also the reason the shape is not simply `listModels()` filtered: the
 * platform view *does* carry `providerModelId` and bot counts, and this one must not.
 *
 * **`capabilities` is served here rather than through a second request.** The configuration
 * UI has to grey out the controls a model cannot honour (§12.3), and it needs that answer
 * while rendering the model selector. Folding it into this projection means the client never
 * has to ask "which model is selected?" and then "what does it support?" as two round trips
 * that can disagree. The resolution mirrors the config endpoint's: an explicit per-model
 * `capabilities` JSON wins field by field over the provider default.
 */
export const listSelectableModels = async (): Promise<SelectableModel[]> => {
  const rows = await prisma.aIModel.findMany({
    where: { enabled: true, provider: { enabled: true } },
    select: {
      id: true,
      displayName: true,
      capabilities: true,
      provider: { select: { slug: true, name: true } },
    },
    orderBy: [{ provider: { name: 'asc' } }, { displayName: 'asc' }],
  });

  return rows.map(({ capabilities, ...model }) => ({
    ...model,
    capabilities: resolveCapabilities({ capabilities, provider: model.provider }),
  }));
};
