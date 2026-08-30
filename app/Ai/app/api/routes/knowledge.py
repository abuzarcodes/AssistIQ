"""API routes for Knowledge Ingestion."""

import uuid
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from app.schemas.knowledge import KnowledgeIngestRequest, KnowledgeIngestResponse, DocumentIngestResponse, KnowledgeEntry
from app.services.knowledge_service import get_knowledge_service, KnowledgeService
from app.services.document_service import get_document_service, DocumentService
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


@router.post("/ingest-document", response_model=DocumentIngestResponse)
async def ingest_document(
    file: UploadFile = File(..., description="PDF or DOCX file to ingest"),
    bot_id: str = Form(..., description="Unique ID of the tenant bot"),
    topic: str = Form(default="", description="Optional topic/category for the document"),
    document_service: DocumentService = Depends(get_document_service),
    knowledge_service: KnowledgeService = Depends(get_knowledge_service),
):
    """Upload a PDF or DOCX file, extract text, and ingest into the RAG pipeline."""
    try:
        # Validate file type
        if not file.filename:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No filename provided."
            )

        # Read file bytes
        file_bytes = await file.read()

        if not file_bytes:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Uploaded file is empty."
            )

        # Extract text from document
        extracted_text, pages_count = document_service.extract_text(file_bytes, file.filename)

        # Use filename as topic if none provided
        effective_topic = topic.strip() if topic.strip() else file.filename.rsplit(".", 1)[0]

        # Create a knowledge entry from the extracted text
        entry_id = f"doc_{uuid.uuid4().hex[:12]}"
        entry = KnowledgeEntry(
            id=entry_id,
            topic=effective_topic,
            content=extracted_text,
        )

        # Run through the existing RAG pipeline (chunk → embed → store)
        result = await knowledge_service.ingest_entries(bot_id, [entry])

        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get("error", "Document ingestion failed")
            )

        logger.info(
            f"Document '{file.filename}' ingested for bot {bot_id}: "
            f"{pages_count} pages, {result['chunks_created']} chunks"
        )

        return DocumentIngestResponse(
            success=True,
            bot_id=bot_id,
            filename=file.filename,
            pages_extracted=pages_count,
            chunks_created=result["chunks_created"],
            status="completed",
        )

    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Document ingestion failed: {e}")
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

