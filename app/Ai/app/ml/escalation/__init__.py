"""Human Escalation Prediction ML model package."""

from app.ml.escalation.features import extract_escalation_features
from app.ml.escalation.model import EscalationModel
from app.ml.escalation.predict import predict_escalation

__all__ = [
    "extract_escalation_features",
    "EscalationModel",
    "predict_escalation",
]
