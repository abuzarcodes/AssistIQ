"""Intent classification ML model package."""

from app.ml.intent.model import IntentClassifier
from app.ml.intent.predict import predict_intent

__all__ = ["IntentClassifier", "predict_intent"]
