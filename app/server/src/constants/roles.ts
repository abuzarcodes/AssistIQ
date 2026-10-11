import { ConversationEventType, ConversationStatus, MessageRole } from '@prisma/client';

/**
 * Chat message roles. Re-exported from the Prisma-generated enum so application
 * code has a single import site and stays in sync with the database schema.
 */
export { MessageRole };

/**
 * Conversation lifecycle states, re-exported for the same reason as `MessageRole`.
 *
 * The lifecycle is the authoritative state machine for human escalation
 * (HUMAN_ESCALATION_IMPLEMENTATION_PLAN.md §8): exactly one value is current at a time,
 * and `HUMAN_ACTIVE` is the only state that requires a non-null `assignedAgentId`.
 */
export { ConversationStatus };

/**
 * The audited lifecycle transitions. Every state change writes one of these in the same
 * transaction as the change itself (§12.1), which is what makes the event table a
 * complete history rather than a best-effort log.
 */
export { ConversationEventType };
