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

export type ModelResolution =
  /** `model` absent means the bot has no assignment — the platform-default path. */
  | { ok: true; model?: ResolvedModelDescriptor }
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
 * Resolve the model that should serve `botId`.
 *
 * One `findUnique` with a nested select, so the bot, its assigned model, and that model's
 * provider arrive in a single round trip. The projection is deliberately narrow: this runs
 * inside the message-send path, and none of the bot's display columns are of any use here.
 *
 * The ladder below is ordered to match the plan's validation ladder, and every rung
 * returns the *same* reason code — the differences live in `detail`, which is a log
 * concern. A customer does not need to know whether a model or its provider was switched
 * off; both mean the same thing to them.
 */
export const resolveBotModel = async (botId: string): Promise<ModelResolution> => {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      aiModelId: true,
      aiModel: {
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

  // The normal, supported state: no assignment means "platform default". Not a failure, and
  // never written implicitly — reaching it here requires the row to actually say `null`.
  if (bot.aiModelId === null) {
    return { ok: true };
  }

  const model = bot.aiModel;

  // Defence in depth. The `Restrict` foreign key makes this unreachable through the API,
  // but a data anomaly must degrade to a fallback rather than throw inside a request that
  // has already stored the customer's message.
  if (!model) {
    return unavailable('assigned model row is missing');
  }

  // `provider` is a required relation, so this too is a shape assertion rather than an
  // expected state — the check exists so the code below can read `.slug` without a guard.
  if (!model.provider) {
    return unavailable('provider row is missing');
  }

  if (!model.provider.enabled) {
    return unavailable(`provider '${model.provider.slug}' is disabled`);
  }

  if (!model.enabled) {
    return unavailable('model is disabled');
  }

  // `provider.slug` and `providerModelId` are the two provider-facing strings. Both are
  // read from the database here — never from a request body — which is what makes the
  // catalog unbypassable rather than merely enforced.
  return {
    ok: true,
    model: { provider: model.provider.slug, model_id: model.providerModelId },
  };
};
