"""API routes for the main Chat Pipeline."""

from fastapi import APIRouter, Depends, HTTPException, status
from app.schemas.chat import ChatRequest, ChatResponse
from app.services.chat_service import get_chat_service, ChatService
from app.providers import ProviderModelRef
from app.core.logging import logger

router = APIRouter(tags=["Chat"])


@router.post("/chat", response_model=ChatResponse)
async def chat_pipeline(
    request: ChatRequest,
    chat_service: ChatService = Depends(get_chat_service)
):
    """Main hybrid deterministic AI chat pipeline for answering user questions."""
    try:
        result = await chat_service.process_chat(
            bot_id=request.bot_id,
            message=request.message,
            # Explicit conversion at the transport boundary: the service layer takes the
            # provider layer's own value type, not a Pydantic request model.
            model=(
                ProviderModelRef(
                    provider=request.model.provider,
                    model_id=request.model.model_id,
                )
                if request.model is not None
                else None
            ),
        )
        # Note: We omit 'debug' block in production response, or we could include it.
        # The prompt requires deterministic endpoints, so we map the service output exactly.

        return ChatResponse(
            status=result["status"],
            response=result["response"],
            fallback_required=result["fallback_required"],
            reason=result["reason"],
            intent=result["intent"],
            retrieval=result["retrieval"]
        )
    except Exception as e:
        logger.error(f"Chat pipeline failed: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))
