"""Inference interface for intent classification."""

from typing import Dict, Any, Optional, List
from app.ml.intent.model import IntentClassifier
from app.core.constants import (
    INTENT_ACCOUNT, INTENT_BILLING, INTENT_TECHNICAL_SUPPORT, INTENT_GENERAL_SUPPORT
)

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
            intent = INTENT_ACCOUNT
        elif any(w in lowered for w in ["price", "billing", "refund", "invoice"]):
            intent = INTENT_BILLING
        elif any(w in lowered for w in ["bug", "error", "issue", "broken"]):
            intent = INTENT_TECHNICAL_SUPPORT
        else:
            intent = INTENT_GENERAL_SUPPORT

        return {
            "intent": intent,
            "confidence": 0.85,
            "probabilities": {intent: 0.85},
            "top_predictions": [{"intent": intent, "confidence": 0.85}],
            "source": "heuristic_fallback",
        }

    predicted_label = model.predict(text)
    probabilities = model.predict_proba(text)
    confidence = probabilities.get(predicted_label, 0.0)
    
    # Sort probabilities to get top predictions
    sorted_probs = sorted(probabilities.items(), key=lambda item: item[1], reverse=True)
    top_predictions = [{"intent": cls, "confidence": round(prob, 4)} for cls, prob in sorted_probs]

    return {
        "intent": predicted_label,
        "confidence": round(confidence, 4),
        "probabilities": probabilities,
        "top_predictions": top_predictions,
        "source": "ml_model",
    }
