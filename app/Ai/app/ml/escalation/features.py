"""Feature extraction definitions for human escalation ML model."""

from typing import Dict, Any, Optional


def extract_escalation_features(
    retrieval_confidence: float,
    message_length: int,
    conversation_length: int = 1,
    intent: Optional[str] = None,
    sentiment_score: float = 0.0,
    previous_failed_responses: int = 0,
) -> Dict[str, Any]:
    """Extract feature vector dictionary for human escalation model inference.
    
    Required Feature Inputs Documented:
    - retrieval_confidence: Vector similarity retrieval score (float 0.0 - 1.0)
    - message_length: Character length of input question (int)
    - conversation_length: Total number of turns in session (int)
    - intent: Categorical classified intent string (str)
    - sentiment_score: Estimated sentiment score (-1.0 negative to +1.0 positive)
    - previous_failed_responses: Count of negative feedback / retry turns (int)
    """
    return {
        "retrieval_confidence": max(0.0, min(1.0, retrieval_confidence)),
        "message_length": message_length,
        "conversation_length": conversation_length,
        "intent_is_technical": 1.0 if intent == "technical_support" else 0.0,
        "intent_is_billing": 1.0 if intent == "billing_inquiry" else 0.0,
        "sentiment_score": max(-1.0, min(1.0, sentiment_score)),
        "previous_failed_responses": previous_failed_responses,
    }
