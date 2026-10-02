"""API routes for System Testing and Debugging."""

from fastapi import APIRouter, Depends, HTTPException, status
from app.schemas.testing import SystemStatusResponse, VectorStoreStats
from app.schemas.chat import ChatRequest, PipelineDebugResponse
from app.services.classifier_service import get_classifier_service, ClassifierService
from app.services.vector_store_service import get_vector_store_service, VectorStoreService
from app.services.embedding_service import get_embedding_service, EmbeddingService
from app.services.llm_service import get_llm_service, LLMService
from app.services.chat_service import get_chat_service, ChatService
from app.providers import ProviderModelRef
from app.core.logging import logger

router = APIRouter(prefix="/testing", tags=["Testing & Debugging"])


@router.get("/status", response_model=SystemStatusResponse)
async def get_system_status(
    classifier: ClassifierService = Depends(get_classifier_service),
    vector_store: VectorStoreService = Depends(get_vector_store_service),
    embedding: EmbeddingService = Depends(get_embedding_service),
    llm: LLMService = Depends(get_llm_service)
):
    """Get health status of all subsystems (ML, VectorDB, LLM)."""
    
    vector_stats = await vector_store.get_stats()
    
    return SystemStatusResponse(
        api="healthy",
        ml_model=classifier.get_status()["status"],
        vector_store=vector_stats["status"],
        embedding_service="configured" if embedding.is_configured else "mock",
        llm="configured" if llm.is_configured else "mock"
    )


@router.get("/vector-store/stats", response_model=VectorStoreStats)
async def get_vector_stats(
    vector_store: VectorStoreService = Depends(get_vector_store_service)
):
    """Get detailed statistics about the pgvector database."""
    try:
        return await vector_store.get_stats()
    except Exception as e:
        logger.error(f"Failed to get vector stats: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.post("/chat-pipeline", response_model=PipelineDebugResponse)
async def debug_chat_pipeline(
    request: ChatRequest,
    chat_service: ChatService = Depends(get_chat_service)
):
    """Run the chat pipeline and return full debug trace information."""
    try:
        result = await chat_service.process_chat(
            bot_id=request.bot_id,
            message=request.message,
            # Same optional descriptor as the production route, so the AI Lab can exercise
            # a specific catalog model rather than only the environment default.
            model=(
                ProviderModelRef(
                    provider=request.model.provider,
                    model_id=request.model.model_id,
                )
                if request.model is not None
                else None
            ),
        )

        # chat_service attaches a full 'debug' dict which fits PipelineDebugResponse
        if "debug" not in result:
            raise HTTPException(status_code=500, detail="Missing debug trace data")
            
        return PipelineDebugResponse(**result["debug"])
        
    except Exception as e:
        logger.error(f"Debug pipeline failed: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))
