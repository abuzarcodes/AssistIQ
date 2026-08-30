"""API routes for Knowledge Ingestion."""

from fastapi import APIRouter, Depends, HTTPException, status
from app.schemas.knowledge import KnowledgeIngestRequest, KnowledgeIngestResponse
from app.services.knowledge_service import get_knowledge_service, KnowledgeService
from app.services.vector_store_service import get_vector_store_service, VectorStoreService
from app.core.logging import logger

router = APIRouter(prefix="/knowledge", tags=["Knowledge Base"])


@router.post("/ingest", response_model=KnowledgeIngestResponse)
async def ingest_knowledge(
    request: KnowledgeIngestRequest,
    knowledge_service: KnowledgeService = Depends(get_knowledge_service)
):
    """Ingest structured knowledge entries, chunk them, embed, and store in vector database."""
    try:
        result = await knowledge_service.ingest_entries(request.bot_id, request.entries)
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
                detail=result.get("error", "Unknown ingestion error")
            )
            
        return KnowledgeIngestResponse(
            success=True,
            bot_id=request.bot_id,
            entries_processed=result["entries_processed"],
            chunks_created=result["chunks_created"],
            status="completed"
        )
    except Exception as e:
        logger.error(f"Ingestion failed: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.delete("/{bot_id}")
async def delete_bot_knowledge(
    bot_id: str,
    vector_store: VectorStoreService = Depends(get_vector_store_service)
):
    """Delete all vector knowledge for a specific bot."""
    try:
        deleted = await vector_store.delete_by_bot(bot_id)
        return {"success": True, "bot_id": bot_id, "chunks_deleted": deleted}
    except Exception as e:
        logger.error(f"Delete failed: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))
