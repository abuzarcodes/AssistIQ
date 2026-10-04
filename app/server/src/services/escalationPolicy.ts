import type { ResolvedBotConfig } from '../types/botConfig.types.js';
import type { ChatResponse } from './aiServiceClient.js';
import { CONVERSATIONAL_FALLBACK_REASONS } from '../constants/botDefaults.js';
import { evaluateBusinessHours } from './businessHours.js';

/**
 * Human-support policy (docs/BOT_IMPLEMENTATION_PLAN.md §14).
 *
 * **Pure and total.** Given a resolved configuration, the AI service's answer, and the
 * current time, it decides whether to escalate, whether that escalation is off-hours, what
 * copy the customer sees, and what acceptance line (handoff or after-hours) accompanies it.
 * No database, no clock read, no side effect — so the whole policy is a table of unit tests
 * rather than an integration exercise.
 *
 * The critical property: **Python decides what the model says; Node decides what the product
 * does.** Nothing here is encoded in the AI service. The fallback copy is the single
 * exception the plan allows, and it is applied here for *conversational* reasons only
 * (§11.6): a platform outage must never be reworded by an owner.
 */

/** The reason recorded when the customer asked for a human rather than the bot failing. */
export const HUMAN_REQUEST_REASON = 'HUMAN_REQUESTED';

/**
 * Fixed copy for `humanRequestBehavior = UNAVAILABLE_MESSAGE`.
 *
 * A constant, not an owner setting: the owner chose "tell them humans are unavailable", and
 * letting them also author the sentence would be a second, undocumented control. Kept warm
 * and non-committal about *why* support is unavailable, because Node does not know.
 */
export const HUMAN_UNAVAILABLE_MESSAGE =
  "Human support isn't available for this assistant right now. I'm still happy to help — is there anything else I can answer?";

export interface EscalationDecision {
  /** Whether the conversation status moves to `WAITING_FOR_HUMAN`. */
  escalate: boolean;
  /** Whether the escalation landed outside configured business hours. */
  offHours: boolean;
  /** The reason code recorded on the conversation (`ai.reason`, or `HUMAN_REQUESTED`). */
  reason: string | null;
  /** The assistant message content, after any owner fallback-copy override. */
  response: string;
  /** Handoff or after-hours copy shown alongside the message, when configured. */
  acceptanceMessage?: string;
}

/**
 * The owner's fallback message, but only for a **conversational** dead end (§11.6).
 *
 * `null` for a platform-fault reason (`MODEL_UNAVAILABLE`, `MODEL_RATE_LIMITED`,
 * `MODEL_ERROR`): those describe an outage on AssistIQ's side, and an owner rewording one
 * into something reassuring would mislead their customers. `null` also when the owner has
 * not set a message, so the platform's per-reason copy passes through unchanged.
 */
export const conversationalFallbackCopy = (
  reason: string | undefined,
  config: ResolvedBotConfig
): string | null => {
  if (!reason || !CONVERSATIONAL_FALLBACK_REASONS.includes(reason)) return null;
  return config.humanSupport.fallbackMessage;
};

/**
 * Escalate, honouring business hours and `afterHoursBehavior`.
 *
 * The three after-hours behaviours (§14.3):
 *   - `MESSAGE_ONLY`         — no status change; the customer sees the after-hours line.
 *   - `MESSAGE_AND_ESCALATE` — escalate, marked off-hours (the default).
 *   - `ESCALATE`             — treated as inside hours; no after-hours line.
 */
const escalateWithHours = (
  config: ResolvedBotConfig,
  now: Date,
  reason: string | null,
  response: string
): EscalationDecision => {
  const support = config.humanSupport;
  const availability = evaluateBusinessHours(support.businessHours, now);

  if (availability.open) {
    return {
      escalate: true,
      offHours: false,
      reason,
      response,
      ...(support.handoffMessage ? { acceptanceMessage: support.handoffMessage } : {}),
    };
  }

  const behavior = support.businessHours?.afterHoursBehavior ?? 'MESSAGE_AND_ESCALATE';
  const afterHoursMessage = support.businessHours?.afterHoursMessage ?? undefined;

  if (behavior === 'MESSAGE_ONLY') {
    return {
      escalate: false,
      offHours: false,
      reason,
      response,
      ...(afterHoursMessage ? { acceptanceMessage: afterHoursMessage } : {}),
    };
  }

  if (behavior === 'ESCALATE') {
    return {
      escalate: true,
      offHours: false,
      reason,
      response,
      ...(support.handoffMessage ? { acceptanceMessage: support.handoffMessage } : {}),
    };
  }

  return {
    escalate: true,
    offHours: true,
    reason,
    response,
    ...(afterHoursMessage ? { acceptanceMessage: afterHoursMessage } : {}),
  };
};

/**
 * Decide the human-support action for one turn.
 *
 * Order matters: an explicit human request is evaluated first, because the model may have
 * answered perfectly well — the customer still asked for a person, and `humanRequestBehavior`
 * is the setting that governs that event. A `fallback_required` answer is the other path.
 *
 * `humanFallbackEnabled = false` is the stronger statement for both paths (§19.2 rule 6): a
 * `TRANSFER_AUTOMATICALLY` request against a bot with fallback off is **inert** rather than a
 * 400, because the owner may be mid-edit and the "no escalation" intent is unambiguous.
 */
export const decideEscalation = (
  config: ResolvedBotConfig,
  ai: ChatResponse,
  now: Date
): EscalationDecision => {
  const support = config.humanSupport;

  if (ai.human_requested) {
    if (support.humanRequestBehavior === 'CONTINUE_WITH_AI') {
      return { escalate: false, offHours: false, reason: null, response: ai.response };
    }
    if (support.humanRequestBehavior === 'UNAVAILABLE_MESSAGE') {
      return {
        escalate: false,
        offHours: false,
        reason: null,
        response: HUMAN_UNAVAILABLE_MESSAGE,
      };
    }
    // TRANSFER_AUTOMATICALLY. The model's answer is kept as the response — the customer gets
    // the answer *and* a human — so no fallback-copy override applies here.
    if (!support.fallbackEnabled) {
      return { escalate: false, offHours: false, reason: null, response: ai.response };
    }
    return escalateWithHours(config, now, HUMAN_REQUEST_REASON, ai.response);
  }

  if (!ai.fallback_required) {
    return { escalate: false, offHours: false, reason: null, response: ai.response };
  }

  const response = conversationalFallbackCopy(ai.reason, config) ?? ai.response;

  if (!support.fallbackEnabled) {
    // Fallback off: the conversation stays ACTIVE and the customer keeps talking to the bot.
    return { escalate: false, offHours: false, reason: ai.reason ?? null, response };
  }

  return escalateWithHours(config, now, ai.reason ?? null, response);
};