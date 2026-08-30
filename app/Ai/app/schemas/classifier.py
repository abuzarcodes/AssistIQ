"""Schemas for ML Classification endpoints."""

from typing import Dict, Any, List
from pydantic import BaseModel, Field


class ClassifyRequest(BaseModel):
    """Request payload for intent classification."""

    text: str = Field(..., description="User input text to classify", example="I want my money back")


class IntentPrediction(BaseModel):
    """Single intent prediction with confidence score."""
    
    intent: str = Field(..., description="Predicted intent class")
    confidence: float = Field(..., description="Confidence score between 0.0 and 1.0")


class ClassifyResponse(BaseModel):
    """Response payload containing intent classification results."""

    predicted_intent: str = Field(..., description="Top predicted intent")
    confidence: float = Field(..., description="Confidence score of top prediction")
    top_predictions: List[IntentPrediction] = Field(
        default_factory=list, description="List of all class predictions sorted by confidence"
    )


class ModelStatusResponse(BaseModel):
    """Response indicating current ML model status and loaded classes."""

    status: str = Field(..., description="Model status (e.g., 'ready', 'not_trained')")
    model_type: str = Field(default="TF-IDF + Logistic Regression", description="Model architecture")
    classes: List[str] = Field(default_factory=list, description="List of supported intents")


class EvaluationResponse(BaseModel):
    """Response payload containing model evaluation metrics."""

    status: str = Field(..., description="Evaluation status")
    model_status: str = Field(..., description="Model training status")
    accuracy: float = Field(..., description="Overall accuracy score")
    precision: float = Field(..., description="Weighted precision score")
    recall: float = Field(..., description="Weighted recall score")
    f1_score: float = Field(..., description="Weighted F1 score")
    classification_report: Dict[str, Any] = Field(..., description="Detailed classification report")
