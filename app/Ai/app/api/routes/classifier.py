"""API routes for ML intent classification."""

from fastapi import APIRouter, Depends, HTTPException, status
from app.schemas.classifier import ClassifyRequest, ClassifyResponse, ModelStatusResponse, EvaluationResponse
from app.services.classifier_service import get_classifier_service, ClassifierService
from app.core.logging import logger

router = APIRouter(prefix="/ml", tags=["Machine Learning"])


@router.post("/classify", response_model=ClassifyResponse)
async def classify_text(
    request: ClassifyRequest,
    classifier: ClassifierService = Depends(get_classifier_service)
):
    """Classify intent of user text with confidence scores."""
    try:
        result = classifier.classify(request.text)
        
        return ClassifyResponse(
            predicted_intent=result["intent"],
            confidence=result["confidence"],
            top_predictions=result.get("top_predictions", [])
        )
    except Exception as e:
        logger.error(f"Classification failed: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.get("/status", response_model=ModelStatusResponse)
async def get_ml_status(
    classifier: ClassifierService = Depends(get_classifier_service)
):
    """Get intent classifier model status and loaded classes."""
    return classifier.get_status()


@router.get("/evaluate", response_model=EvaluationResponse)
async def evaluate_ml_model(
    classifier: ClassifierService = Depends(get_classifier_service)
):
    """Run evaluation metrics on the ML model against test data."""
    try:
        result = classifier.run_evaluation()
        if result["status"] == "error":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=result["message"])
        return result
    except Exception as e:
        logger.error(f"Evaluation failed: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))
