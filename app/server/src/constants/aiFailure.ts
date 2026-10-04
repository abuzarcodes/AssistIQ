/**
 * Failure vocabulary for the model-resolution path (Checkpoint 6).
 *
 * A bot whose assigned model cannot serve a request does **not** silently fall back to
 * another model. It produces an explicit, user-visible fallback carrying a machine-readable
 * reason and escalates to a human — the same escalation the platform already uses when the
 * classifier or retrieval cannot answer.
 *
 * The three codes are one vocabulary shared across the Node → Python boundary. Node only
 * ever *originates* `MODEL_UNAVAILABLE` (every condition it can detect is a catalog/fleet
 * state); the other two arrive from Python, which is where a live provider call happens,
 * and are declared here so both sides name the same thing.
 *
 * Nothing in this file names a provider, a model, or a configuration state — these values
 * are returned to the client and rendered in the inbox.
 */
export const AI_FAILURE_REASON = {
  /** The assigned model cannot serve: row missing, disabled, or its provider is disabled. */
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  /** The provider throttled the request. Transient; a retry may succeed. */
  MODEL_RATE_LIMITED: 'MODEL_RATE_LIMITED',
  /** The provider failed or timed out. Transient and not attributable to configuration. */
  MODEL_ERROR: 'MODEL_ERROR',
} as const;

export type AIFailureReason = (typeof AI_FAILURE_REASON)[keyof typeof AI_FAILURE_REASON];

/**
 * The customer-facing text shown when Node short-circuits before reaching the AI service.
 *
 * Deliberately a constant here rather than a call to Python's `FallbackService`: this
 * describes a platform-configuration fault, not a conversational dead end, and the wording
 * differs by design. Deliberately says nothing about *which* model or provider is at fault —
 * that belongs in the operator log, not in a customer's support thread.
 */
export const MODEL_UNAVAILABLE_MESSAGE =
  'This assistant is temporarily unavailable. A member of the team has been notified and will follow up.';

/**
 * The customer-facing text shown when the bot itself is paused (§5.1, §6 `isActive`).
 *
 * A paused bot is a deliberate owner action, not a fault, so it does **not** escalate: the
 * conversation stays `ACTIVE` and the customer is simply told the assistant is offline. The
 * wording deliberately avoids naming a model or a provider — pausing is a product state.
 */
export const BOT_PAUSED_MESSAGE =
  'This assistant is currently paused. Please try again later.';
