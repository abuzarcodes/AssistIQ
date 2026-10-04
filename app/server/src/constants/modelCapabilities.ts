/**
 * Model generation-parameter capabilities (docs/BOT_IMPLEMENTATION_PLAN.md §12).
 *
 * **Node's catalog is authoritative.** A capability is *catalog metadata about a selected
 * model*, so it belongs with the `AIModel` row — which is why this table lives here and not
 * in Python. The AI service declares `supported_params` per adapter as a second, independent
 * gate (§11.4); that is a statement about its own adapter code, not a copy of the catalog.
 * Two gates, each authoritative for its own layer.
 */

import type { ModelCapabilities } from '../types/botConfig.types.js';

/**
 * Capabilities assumed for a model whose provider has not been given an explicit entry.
 *
 * Permissive on purpose: an unknown provider slug is one this table has not learned yet,
 * and the adapter's own `supported_params` intersection is what actually protects the
 * provider call. Being restrictive here would silently disable controls the model supports.
 */
export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  temperature: true,
  topP: true,
  maxTokens: true,
  frequencyPenalty: true,
  presencePenalty: true,
};

/**
 * Per-provider defaults, keyed by `AIProvider.slug` (the same slug the Python adapter
 * registry uses). A model may override any of these through `AIModel.capabilities`.
 *
 * `gemini` has no OpenAI-style frequency/presence penalty: the Google SDK exposes
 * `temperature` and `top_p`, and its token cap is `max_output_tokens` rather than
 * `max_tokens`.
 */
export const PROVIDER_CAPABILITY_DEFAULTS: Record<string, ModelCapabilities> = {
  openai: { ...DEFAULT_CAPABILITIES },
  openrouter: { ...DEFAULT_CAPABILITIES },
  groq: { ...DEFAULT_CAPABILITIES },
  openai_compatible: { ...DEFAULT_CAPABILITIES },
  gemini: {
    temperature: true,
    topP: true,
    maxTokens: true,
    frequencyPenalty: false,
    presencePenalty: false,
  },
};

/**
 * Resolve the effective capabilities for one catalog model.
 *
 * Precedence: an explicit per-model `capabilities` JSON **replaces** the provider default
 * field by field where present. A model row that declares only `{ frequencyPenalty: false }`
 * therefore inherits everything else from its provider — which is what an operator editing
 * one checkbox in the platform UI would expect.
 *
 * A malformed JSON value degrades to the provider default rather than throwing: the
 * capability table is advisory metadata, and a bot must keep working even if an operator
 * once wrote something odd into the column.
 */
export const resolveCapabilities = (model: {
  capabilities?: unknown;
  provider: { slug: string };
}): ModelCapabilities => {
  const providerDefault =
    PROVIDER_CAPABILITY_DEFAULTS[model.provider.slug] ?? DEFAULT_CAPABILITIES;

  const override = model.capabilities;
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return { ...providerDefault };
  }

  const record = override as Record<string, unknown>;
  const result: ModelCapabilities = { ...providerDefault };

  for (const key of Object.keys(result) as Array<keyof ModelCapabilities>) {
    const value = record[key];
    if (typeof value === 'boolean') {
      result[key] = value;
    }
  }

  return result;
};

/**
 * Whether the platform model form should show a capability editor for a provider.
 * Exported so the client and server agree on which providers have a meaningful default.
 */
export const knownProviderCapabilities = (slug: string): ModelCapabilities =>
  PROVIDER_CAPABILITY_DEFAULTS[slug] ?? DEFAULT_CAPABILITIES;
