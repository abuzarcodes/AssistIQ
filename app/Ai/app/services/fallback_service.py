"""Fallback Service for handling failed pipeline states."""

from typing import Dict, Any
from app.core.constants import (
    FALLBACK_REASON_LOW_CLASSIFICATION_CONFIDENCE,
    FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE,
    FALLBACK_REASON_LOW_RETRIEVAL_CONFIDENCE,
    FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION,
    DEFAULT_FALLBACK_MESSAGE
)


class FallbackService:
    """Service layer for generating fallback responses."""

    def __init__(self):
        # We could load custom fallback messages per bot from a DB here later
        self.default_message = DEFAULT_FALLBACK_MESSAGE

    def get_fallback(self, reason: str, bot_id: str) -> Dict[str, Any]:
        """Generate a fallback response based on the reason."""
        
        # In a real system, you might look up bot_id to get customized messages.
        # For now, we return standard messages based on the reason code.
        
        if reason == FALLBACK_REASON_LOW_CLASSIFICATION_CONFIDENCE:
            message = "I'm not quite sure I understand your request. Could you please rephrase?"
        elif reason == FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE:
            message = "I couldn't find any information about that in my knowledge base. Let me connect you to a human agent."
        elif reason == FALLBACK_REASON_LOW_RETRIEVAL_CONFIDENCE:
            message = "I found some information, but I'm not confident it answers your question. Please contact support."
        elif reason == FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION:
            message = "Based on the provided information, I cannot answer your question accurately."
        else:
            message = self.default_message
            
        return {
            "fallback_required": True,
            "reason": reason,
            "response": message
        }


_fallback_service_instance = None


def get_fallback_service() -> FallbackService:
    """Dependency injector for FallbackService singleton."""
    global _fallback_service_instance
    if _fallback_service_instance is None:
        _fallback_service_instance = FallbackService()
    return _fallback_service_instance
