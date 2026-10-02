"""Application-wide constants and enumerations."""

# Intent Categories
INTENT_ACCOUNT = "ACCOUNT"
INTENT_BILLING = "BILLING"
INTENT_PRICING = "PRICING"
INTENT_REFUND = "REFUND"
INTENT_SUBSCRIPTION = "SUBSCRIPTION"
INTENT_TECHNICAL_SUPPORT = "TECHNICAL_SUPPORT"
INTENT_GENERAL_SUPPORT = "GENERAL_SUPPORT"

# List of all valid intents for training/validation
VALID_INTENTS = [
    INTENT_ACCOUNT,
    INTENT_BILLING,
    INTENT_PRICING,
    INTENT_REFUND,
    INTENT_SUBSCRIPTION,
    INTENT_TECHNICAL_SUPPORT,
    INTENT_GENERAL_SUPPORT,
]

# Fallback Reason Codes
FALLBACK_REASON_LOW_CLASSIFICATION_CONFIDENCE = "LOW_CLASSIFICATION_CONFIDENCE"
FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE = "NO_RELEVANT_KNOWLEDGE"
FALLBACK_REASON_LOW_RETRIEVAL_CONFIDENCE = "LOW_RETRIEVAL_CONFIDENCE"
FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION = "LLM_INSUFFICIENT_INFORMATION"

# Model Failure Reason Codes (Checkpoint 6).
#
# These describe a *provider-side* failure, not a conversational dead end, and they share
# one vocabulary with Node's `constants/aiFailure.ts`. Node originates
# FALLBACK_REASON_MODEL_UNAVAILABLE for every condition it can detect before calling us;
# the other two can only be known here, where the provider call actually happens.
#
# They are deliberately separate from the codes above: a customer seeing one of these is
# told the assistant is unavailable, whereas the conversational codes invite them to
# rephrase. Merging them would lose that distinction.
FALLBACK_REASON_MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
FALLBACK_REASON_MODEL_RATE_LIMITED = "MODEL_RATE_LIMITED"
FALLBACK_REASON_MODEL_ERROR = "MODEL_ERROR"

#: Every model-failure code, as a set — so a new code added above cannot be forgotten by
#: the mapping that produces it.
MODEL_FAILURE_REASONS = frozenset(
    {
        FALLBACK_REASON_MODEL_UNAVAILABLE,
        FALLBACK_REASON_MODEL_RATE_LIMITED,
        FALLBACK_REASON_MODEL_ERROR,
    }
)

# Internal LLM Signal
INSUFFICIENT_INFORMATION_SIGNAL = "INSUFFICIENT_INFORMATION"

# Default Fallback Message
DEFAULT_FALLBACK_MESSAGE = "I don't have enough information to answer that accurately. Please contact our support team for further assistance."
