import { apiGet, apiPatch, apiPost, apiDelete } from '@/lib/api-client';

/**
 * The AI model catalog, from both sides of the trust boundary.
 *
 * The platform functions are behind `requirePlatformOwner()`; `listAvailableModels` is the
 * workspace-facing read that returns only *enabled* models of *enabled* providers. They
 * live together because they describe one catalog — a client that could see only half of
 * it would hard-code the other half.
 *
 * **No credential ever appears in these types.** A provider's readiness arrives as two
 * independent nullable booleans, never as one "configured" flag and never as a key, a URL
 * or a masked fragment of either.
 */

export interface AIProvider {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  modelCount: number;
  enabledModelCount: number;
  /**
   * Readiness axis 1 — a Python adapter is registered for this slug. `null` means the AI
   * service could not be asked, which is **not** the same as `false`: `false` says "no
   * adapter exists" and points at a code change, `null` says "unknown".
   */
  adapterAvailable: boolean | null;
  /**
   * Readiness axis 2 — the adapter reports a credential is present. `null` when the AI
   * service was unreachable *or* when there is no adapter whose credential could be
   * checked. Neither is "no credential".
   */
  credentialConfigured: boolean | null;
}

export interface AIModel {
  id: string;
  providerId: string;
  /** Provider-native id. Shown read-only; it is immutable after creation. */
  providerModelId: string;
  displayName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  provider: { id: string; slug: string; name: string; enabled: boolean };
  /** A live count of bots referencing this model, never a stored counter. */
  botCount: number;
}

/** Which generation parameters a model's adapter actually accepts (plan §12). */
export interface ModelCapabilities {
  temperature: boolean;
  topP: boolean;
  maxTokens: boolean;
  frequencyPenalty: boolean;
  presencePenalty: boolean;
}

/**
 * A model a workspace may select: enabled, under an enabled provider.
 *
 * `capabilities` travels with the list so the configuration UI can disable a control the
 * selected model cannot use without a second request. The stored value is never cleared —
 * an owner's setting survives a temporary model swap and reactivates on a capable model.
 */
export interface SelectableModel {
  id: string;
  displayName: string;
  provider: { slug: string; name: string };
  capabilities: ModelCapabilities;
}

export interface CreateModelInput {
  providerId: string;
  providerModelId: string;
  displayName: string;
  /** Omitted: the server creates models disabled, and the UI does not override that. */
}

export interface UpdateModelInput {
  displayName?: string;
  enabled?: boolean;
}

export interface UpdateProviderInput {
  enabled?: boolean;
}

// --- Platform owner: `/platform/*` ------------------------------------------------------

export function listProviders() {
  return apiGet<AIProvider[]>('/platform/providers');
}

export function updateProvider(providerId: string, data: UpdateProviderInput) {
  return apiPatch<AIProvider>(`/platform/providers/${providerId}`, data);
}

export function listModels() {
  return apiGet<AIModel[]>('/platform/models');
}

export function createModel(data: CreateModelInput) {
  return apiPost<AIModel>('/platform/models', data);
}

export function updateModel(modelId: string, data: UpdateModelInput) {
  return apiPatch<AIModel>(`/platform/models/${modelId}`, data);
}

export function deleteModel(modelId: string) {
  return apiDelete<null>(`/platform/models/${modelId}`);
}

// --- Workspace: `/ai/*` -----------------------------------------------------------------

/**
 * The models a bot may be pointed at. The server filters to enabled models of enabled
 * providers, so a disabled model is absent by construction rather than hidden here.
 */
export function listAvailableModels() {
  return apiGet<SelectableModel[]>('/ai/models');
}
