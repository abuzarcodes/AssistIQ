"""API routes for RAG search testing."""

from fastapi import APIRouter, Depends, HTTPException, status
from app.schemas.rag import RAGSearchRequest, RAGSearchResponse
from app.services.rag_service import get_rag_service, RAGService
from app.core.logging import logger

router = APIRouter(prefix="/rag", tags=["Retrieval-Augmented Generation"])


@router.post("/search", response_model=RAGSearchResponse)
async def search_vectors(
    request: RAGSearchRequest,
    rag_service: RAGService = Depends(get_rag_service)
):
    """Perform a vector similarity search across a bot's knowledge chunks."""
    try:
        result = await rag_service.search(
            query=request.query,
            bot_id=request.bot_id,
            top_k=request.top_k,
            topic_filter=request.topic_filter
        )
        
        return RAGSearchResponse(
            query=request.query,
            results=result["results"]
        )
    except Exception as e:
        logger.error(f"RAG search failed: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))
