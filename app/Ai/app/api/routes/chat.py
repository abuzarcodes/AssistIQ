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
            fallback_model=(
                ProviderModelRef(
                    provider=request.fallback_model.provider,
                    model_id=request.fallback_model.model_id,
                )
                if request.fallback_model is not None
                else None
            ),
            # Passed as the schema model rather than a dict: the prompt builder reads typed
            # attributes, and the validation that rejected a reserved sentinel in an owner's
            # instructions has already run by this point.
            config=request.config,
        )
        # Note: We omit 'debug' block in production response, or we could include it.
        # The prompt requires deterministic endpoints, so we map the service output exactly.
        # `result` is a dict, and mapping it explicitly (rather than splatting it) is what
        # keeps `debug` — which contains the full retrieval text and both prompts — out of
        # the response, so a new key in the pipeline cannot leak here by accident.
        #
        # `model_used` and `failover_used` are mapped because Node reads them for logging
        # and for `effective`; the plan makes it Node's job not to forward them onward, which
        # is a rule it can only follow if it receives them. `human_requested` is a detection
        # Node acts on via `humanRequestBehavior` — this service decides nothing about it.

        return ChatResponse(
            status=result["status"],
            response=result["response"],
            fallback_required=result["fallback_required"],
            reason=result["reason"],
            intent=result["intent"],
            retrieval=result["retrieval"],
            sources=result.get("sources"),
            model_used=result.get("model_used"),
            failover_used=result.get("failover_used", False),
            human_requested=result.get("human_requested", False),
        )
    except Exception as e:
        logger.error(f"Chat pipeline failed: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))
