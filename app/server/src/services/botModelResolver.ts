import prisma from '../config/database.js';
import { AI_FAILURE_REASON } from '../constants/aiFailure.js';

/**
 * Runtime model resolution (Checkpoint 6).
 *
 * Answers one question, once per customer message: *which model should serve this bot?*
 * Three possible answers — a specific catalog model, the platform default (no model
 * assigned), or **cannot serve** — and the third is reserved for a state the *catalog*
 * says is unusable. That distinction is the whole point: "no model assigned" is a normal,
 * supported product state, while "assigned model unusable" is an explicit failure, and the
 * two must never behave the same way.
 *
 * **No cache, by design.** Catalog state is re-read on every call, which is what makes a
 * platform-owner disable take effect on the next message without a restart — and why there
 * is no invalidation logic to get wrong.
 */

/** The descriptor Python receives: a provider slug and that provider's own model id. */
export interface ResolvedModelDescriptor {
  provider: string;
  model_id: string;
}

/** The shape of one assigned model's nested select, named so `describe` can take it. */
interface ModelFactsRow {
  providerModelId: string;
  enabled: boolean;
  provider: { slug: string; enabled: boolean } | null;
}

/**
 * The outcome of resolving a bot's models (§13.2).
 *
 * `promoted` is the field that makes failover *visible*: it is true only when the primary is
 * unusable and the fallback is taking over, which is a state the owner must be told about
 * ("your primary model is unavailable; the fallback is serving") rather than one the system
 * should paper over silently.
 */
export type ModelResolution =
  /**
   * `model` absent means the bot has no primary assignment — the platform-default path.
   * `fallbackModel` is present only when a fallback is configured *and* usable, so Python
   * can retry the generation step without a second round trip through Node.
   */
  | {
      ok: true;
      model?: ResolvedModelDescriptor;
      fallbackModel?: ResolvedModelDescriptor;
      promoted: boolean;
    }
  | { ok: false; reason: typeof AI_FAILURE_REASON.MODEL_UNAVAILABLE; detail: string };

/**
 * `detail` is for **logs only**. It names the broken row, which is exactly what an operator
 * needs and exactly what a customer must never see — `MODEL_UNAVAILABLE_MESSAGE` is what
 * reaches the conversation.
 */
const unavailable = (detail: string): ModelResolution => ({
  ok: false,
  reason: AI_FAILURE_REASON.MODEL_UNAVAILABLE,
  detail,
});

/**
 * Resolve the models that should serve `botId` (§13.2).
 *
 * One `findUnique` with a nested select, so the bot, both assigned models and their
 * providers arrive in a **single round trip**. That is a hard constraint, not a preference:
 * this runs inside the message-send path, and `bot-model-resolution.test.ts` pins the call
 * count at one.
 *
 * The ladder:
 *
 *   1. Primary usable → the primary serves; the fallback is sent along if it is also usable.
 *   2. Primary unusable, fallback usable → **the fallback serves and the primary is never
 *      called**, with `promoted: true`. Reusing the existing "validate before spending
 *      provider money" property.
 *   3. Primary usable, fallback unusable → the primary serves and failover is simply
 *      unavailable. Never a user-visible error: a missing backup is not a fault.
 *   4. Neither usable → `{ ok: false }`, the existing `MODEL_UNAVAILABLE` short-circuit.
 *
 * Every rung returns the *same* reason code; the differences live in `detail`, which is a
 * log concern. A customer does not need to know whether a model or its provider was
 * switched off — both mean the same thing to them.
 */
export const resolveBotModel = async (botId: string): Promise<ModelResolution> => {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      aiModelId: true,
      fallbackAiModelId: true,
      aiModel: {
        select: {
          providerModelId: true,
          enabled: true,
          provider: { select: { slug: true, enabled: true } },
        },
      },
      fallbackAiModel: {
        select: {
          providerModelId: true,
          enabled: true,
          provider: { select: { slug: true, enabled: true } },
        },
      },
    },
  });

  // A bot row that cannot be read at all. `getOwnedConversation` has already established
  // that the conversation — and therefore, via its foreign key, the bot — exists, so this
  // is a read anomaly rather than a data state. It is reported as a failure rather than
  // treated as "no model assigned": silently serving the platform default would attribute
  // an answer to a model the workspace did not choose, which is the substitution the whole
  // failure policy exists to prevent.
  if (!bot) {
    return unavailable('bot row not found');
  }

  /**
   * Turn an assigned model into a descriptor, or explain why it cannot serve.
   *
   * `assignedId` is checked before the relation is read, because a `Restrict` foreign key
   * makes "id set, relation null" unreachable through the API — so reaching it means a data
   * anomaly, and it must degrade rather than throw inside a request that has already stored
   * the customer's message.
   */
  const describe = (
    assignedId: string | null,
    model: ModelFactsRow | null,
    role: 'primary' | 'fallback'
  ): { descriptor: ResolvedModelDescriptor } | { failure: string } => {
    if (assignedId === null) {
      return { failure: `${role} not assigned` };
    }
    if (!model) {
      return { failure: `${role} model row is missing` };
    }
    // `provider` is a required relation, so this too is a shape assertion rather than an
    // expected state — the check exists so the code below can read `.slug` without a guard.
    if (!model.provider) {
      return { failure: `${role} provider row is missing` };
    }
    if (!model.provider.enabled) {
      return { failure: `${role} provider '${model.provider.slug}' is disabled` };
    }
    if (!model.enabled) {
      return { failure: `${role} model is disabled` };
    }

    // `provider.slug` and `providerModelId` are the two provider-facing strings. Both are
    // read from the database here — never from a request body — which is what makes the
    // catalog unbypassable rather than merely enforced.
    return { descriptor: { provider: model.provider.slug, model_id: model.providerModelId } };
  };

  // The normal, supported state: no primary assignment means "platform default". Not a
  // failure, and never written implicitly. There is nothing to fail over *from*, so a
  // configured fallback is irrelevant here and is not resolved.
  if (bot.aiModelId === null) {
    return { ok: true, promoted: false };
  }

  const primary = describe(bot.aiModelId, bot.aiModel, 'primary');
  const fallback = describe(bot.fallbackAiModelId, bot.fallbackAiModel, 'fallback');

  if ('descriptor' in primary) {
    return {
      ok: true,
      model: primary.descriptor,
      // Sent along only when it can actually serve. Sending an unusable fallback would make
      // Python attempt a retry that is guaranteed to fail, spending a second timeout on a
      // request that could have escalated immediately (§13.2 rung 3).
      ...('descriptor' in fallback ? { fallbackModel: fallback.descriptor } : {}),
      promoted: false,
    };
  }

  // Rung 2: the primary is unusable, so the fallback serves and the primary is never
  // called — the validation-before-spend property this resolver already had.
  if ('descriptor' in fallback) {
    return { ok: true, model: fallback.descriptor, promoted: true };
  }

  // Rung 4: neither can serve. `detail` names both so an operator can see which end of the
  // pair to fix; it never leaves the logs (see `unavailable`).
  return unavailable(`${primary.failure}; ${fallback.failure}`);
};
