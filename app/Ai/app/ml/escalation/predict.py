"""Inference interface for escalation prediction."""

from typing import Dict, Any, Optional
from app.ml.escalation.features import extract_escalation_features
from app.ml.escalation.model import EscalationModel

_escalation_model_instance: Optional[EscalationModel] = None


def get_escalation_model() -> EscalationModel:
    """Get or initialize singleton instance of EscalationModel."""
    global _escalation_model_instance
    if _escalation_model_instance is None:
        _escalation_model_instance = EscalationModel()
        _escalation_model_instance.load()
    return _escalation_model_instance


def predict_escalation(
    retrieval_confidence: float,
    message_length: int,
    conversation_length: int = 1,
    intent: Optional[str] = None,
    sentiment_score: float = 0.0,
    previous_failed_responses: int = 0,
) -> Dict[str, Any]:
    """Extract features and calculate escalation probability."""
    features = extract_escalation_features(
        retrieval_confidence=retrieval_confidence,
        message_length=message_length,
        conversation_length=conversation_length,
        intent=intent,
        sentiment_score=sentiment_score,
        previous_failed_responses=previous_failed_responses,
    )

    model = get_escalation_model()
    should_escalate = model.predict(features)
    escalation_score = model.predict_proba(features)

    return {
        "should_escalate": should_escalate,
        "escalation_score": round(escalation_score, 4),
        "features_evaluated": features,
    }
