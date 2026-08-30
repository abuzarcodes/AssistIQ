"""Classifier Service wrapping the ML intent model."""

from typing import Dict, Any, List
from app.ml.intent.predict import get_intent_model, predict_intent
from app.ml.training.evaluate import evaluate_model
from app.core.config import settings
from app.core.logging import logger, format_log_context


class ClassifierService:
    """Service layer for intent classification operations."""

    def __init__(self):
        self.model = get_intent_model()
        self.confidence_threshold = settings.CLASSIFICATION_CONFIDENCE_THRESHOLD

    def classify(self, text: str) -> Dict[str, Any]:
        """Classify intent for a given text."""
        result = predict_intent(text)
        
        # Check against threshold
        confidence = result.get("confidence", 0.0)
        is_confident = confidence >= self.confidence_threshold
        
        result["is_confident"] = is_confident
        result["threshold"] = self.confidence_threshold
        
        logger.info(
            f"Classified intent: {result['intent']} (confidence: {confidence:.2f})",
            extra=format_log_context(
                operation="classify_intent",
                intent=result["intent"],
                confidence=confidence,
                is_confident=is_confident
            ),
        )
        return result

    def get_status(self) -> Dict[str, Any]:
        """Get model status and supported classes."""
        is_ready = self.model.is_fitted
        classes = self.model.get_classes()
        
        return {
            "status": "ready" if is_ready else "not_trained",
            "model_type": "TF-IDF + Logistic Regression",
            "classes": classes,
        }

    def run_evaluation(self) -> Dict[str, Any]:
        """Run evaluation pipeline on training data."""
        return evaluate_model()


_classifier_service_instance = None


def get_classifier_service() -> ClassifierService:
    """Dependency injector for ClassifierService singleton."""
    global _classifier_service_instance
    if _classifier_service_instance is None:
        _classifier_service_instance = ClassifierService()
    return _classifier_service_instance
