"""ML Service for high-level model inference integration."""

from typing import Dict, Any, Optional
from app.ml.intent.predict import predict_intent
from app.ml.escalation.predict import predict_escalation
from app.core.logging import logger, format_log_context


class MLService:
    """Service encapsulating custom scikit-learn ML models for runtime inference."""

    async def predict_intent_for_text(self, text: str) -> Dict[str, Any]:
        """Predict conversation intent tag and probability distribution."""
        result = predict_intent(text)
        logger.info(
            "Intent predicted",
            extra=format_log_context(
                operation="predict_intent",
                intent=result["intent"],
                confidence=result["confidence"],
            ),
        )
        return result

    async def predict_human_escalation(
        self,
        retrieval_confidence: float,
        message_length: int,
        conversation_length: int = 1,
        intent: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Predict whether a conversation turn should be escalated to a human agent."""
        result = predict_escalation(
            retrieval_confidence=retrieval_confidence,
            message_length=message_length,
            conversation_length=conversation_length,
            intent=intent,
        )
        logger.info(
            "Escalation predicted",
            extra=format_log_context(
                operation="predict_escalation",
                should_escalate=result["should_escalate"],
                score=result["escalation_score"],
            ),
        )
        return result


_ml_service_instance: Optional[MLService] = None


def get_ml_service() -> MLService:
    """Dependency injector for MLService singleton instance."""
    global _ml_service_instance
    if _ml_service_instance is None:
        _ml_service_instance = MLService()
    return _ml_service_instance
