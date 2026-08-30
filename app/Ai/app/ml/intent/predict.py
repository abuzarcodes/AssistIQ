"""Inference interface for intent classification."""

from typing import Dict, Any, Optional
from app.ml.intent.model import IntentClassifier

_intent_model_instance: Optional[IntentClassifier] = None


def get_intent_model() -> IntentClassifier:
    """Get or initialize singleton instance of IntentClassifier."""
    global _intent_model_instance
    if _intent_model_instance is None:
        _intent_model_instance = IntentClassifier()
        # Attempt loading pre-trained artifact if available
        _intent_model_instance.load()
    return _intent_model_instance


def predict_intent(text: str) -> Dict[str, Any]:
    """Inference entry point for intent prediction."""
    model = get_intent_model()
    if not model.is_fitted:
        # Rules-based fallback for common patterns when no trained ML model exists
        lowered = text.lower()
        if any(w in lowered for w in ["password", "reset", "login", "account"]):
            intent = "account_support"
        elif any(w in lowered for w in ["price", "billing", "refund", "invoice"]):
            intent = "billing_inquiry"
        elif any(w in lowered for w in ["bug", "error", "issue", "broken"]):
            intent = "technical_support"
        else:
            intent = "general_inquiry"

        return {
            "intent": intent,
            "confidence": 0.85,
            "probabilities": {intent: 0.85},
            "source": "heuristic_fallback",
        }

    predicted_label = model.predict(text)
    probabilities = model.predict_proba(text)
    confidence = probabilities.get(predicted_label, 0.0)

    return {
        "intent": predicted_label,
        "confidence": round(confidence, 4),
        "probabilities": probabilities,
        "source": "ml_model",
    }
