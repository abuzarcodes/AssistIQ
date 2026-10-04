"""API routes for Knowledge Ingestion."""

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status

from app.schemas.knowledge import (
    BulkChunkIdsRequest,
    BulkChunkOperationResponse,
    BulkChunkToggleRequest,
    BulkDeleteSourcesRequest,
    BulkDeleteSourcesResponse,
    ChunkToggleRequest,
    ChunkToggleResponse,
    DeleteChunkResponse,
    DocumentIngestResponse,
    KnowledgeIngestRequest,
    KnowledgeIngestResponse,
    ReEmbedRequest,
    ReEmbedResponse,
)
from app.services.knowledge_service import get_knowledge_service, KnowledgeService
from app.services.embedding_service import EmbeddingFailedError, EmbeddingUnavailableError
from app.services.vector_store_service import get_vector_store_service, VectorStoreService
from app.core.logging import logger

router = APIRouter(prefix="/knowledge", tags=["Knowledge Base"])

#: Every chunk endpoint requires the owning bot. Chunk ids are not secret — the FAQ
#: path derives them from the bot id and entry id — so the id alone must never be
#: enough to read or mutate a chunk. Scoping by bot_id makes a foreign id resolve to
#: "not found" rather than to someone else's data.
BOT_ID_QUERY = Query(..., description="Owning bot ID; the chunk must belong to it")


def _embedding_http_error(err: Exception) -> HTTPException:
    """Map an embedding failure onto a status that says whose fault it is.

    A missing credential is a deployment problem (503); a provider that was
    reachable but failed is an upstream problem (502). Collapsing both into 500
    would hide which of the two an operator needs to fix.
    """
    if isinstance(err, EmbeddingUnavailableError):
        return HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(err))
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(err))


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
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Ingestion failed: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.post("/ingest-document", response_model=DocumentIngestResponse)
async def ingest_document(
    file: UploadFile = File(..., description="PDF or DOCX file to ingest"),
    bot_id: str = Form(..., description="Unique ID of the tenant bot"),
    source_id: str = Form(..., description="Server-side knowledge_sources row ID these vectors belong to"),
    topic: str = Form(default="", description="Optional topic/category for the document"),
    knowledge_service: KnowledgeService = Depends(get_knowledge_service),
):
    """Upload a PDF or DOCX file, extract text, and ingest into the RAG pipeline.

    Returns per-chunk detail so the server can mirror the vectors as metadata rows.
    """
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

        # Use filename as topic if none provided
        effective_topic = topic.strip() if topic.strip() else file.filename.rsplit(".", 1)[0]

        result = await knowledge_service.ingest_document(
            bot_id=bot_id,
            source_id=source_id,
            filename=file.filename,
            file_bytes=file_bytes,
            topic=effective_topic,
        )

        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get("error", "Document ingestion failed"),
            )

        return DocumentIngestResponse(
            success=True,
            bot_id=bot_id,
            filename=file.filename,
            pages_extracted=result["pages_extracted"],
            chunks_created=result["chunks_created"],
            status="completed",
            embedding_model=result["embedding_model"],
            embedding_dimension=result["embedding_dimension"],
            chunks=result["chunks"],
        )

    except ValueError as e:
        # Raised by the extractor for unsupported types, empty text and oversize files —
        # all of them the caller's fault, so 400 rather than 500.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except (EmbeddingUnavailableError, EmbeddingFailedError) as e:
        raise _embedding_http_error(e)
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Document ingestion failed: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.post("/chunks/{chunk_id}/re-embed", response_model=ReEmbedResponse)
async def re_embed_chunk(
    chunk_id: str,
    request: ReEmbedRequest,
    bot_id: str = BOT_ID_QUERY,
    knowledge_service: KnowledgeService = Depends(get_knowledge_service),
):
    """Replace a chunk's text and regenerate its vector.

    Never writes a placeholder vector: if the embedding provider fails, the stored
    vector is left as it was and the caller gets an error. See
    `KnowledgeService.re_embed_chunk`.
    """
    try:
        result = await knowledge_service.re_embed_chunk(bot_id, chunk_id, request.content)
    except (EmbeddingUnavailableError, EmbeddingFailedError) as e:
        raise _embedding_http_error(e)
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except Exception as e:
        logger.error(f"Re-embed failed for chunk {chunk_id}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chunk not found.")

    return ReEmbedResponse(success=True, **result)


@router.patch("/chunks/{chunk_id}/toggle", response_model=ChunkToggleResponse)
async def toggle_chunk(
    chunk_id: str,
    request: ChunkToggleRequest,
    bot_id: str = BOT_ID_QUERY,
    knowledge_service: KnowledgeService = Depends(get_knowledge_service),
):
    """Enable or disable one chunk's vector, removing it from (or restoring it to) retrieval."""
    try:
        chunk = await knowledge_service.toggle_chunk(bot_id, chunk_id, request.enabled)
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except Exception as e:
        logger.error(f"Toggle failed for chunk {chunk_id}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    if chunk is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chunk not found.")

    return ChunkToggleResponse(success=True, chunk_id=chunk_id, enabled=chunk["enabled"])


# NOTE: `/chunks/bulk` is declared before `/chunks/{chunk_id}` on purpose. FastAPI
# matches routes in declaration order, so the parameterised route declared first would
# capture the literal path "bulk" as a chunk id.
@router.delete("/chunks/bulk", response_model=BulkChunkOperationResponse)
async def bulk_delete_chunks(
    request: BulkChunkIdsRequest,
    bot_id: str = BOT_ID_QUERY,
    knowledge_service: KnowledgeService = Depends(get_knowledge_service),
):
    """Delete several chunks' vectors in one call."""
    try:
        result = await knowledge_service.bulk_delete(bot_id, request.chunk_ids)
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except Exception as e:
        logger.error(f"Bulk delete failed for bot {bot_id}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    return BulkChunkOperationResponse(success=True, **result)


@router.post("/chunks/bulk-toggle", response_model=BulkChunkOperationResponse)
async def bulk_toggle_chunks(
    request: BulkChunkToggleRequest,
    bot_id: str = BOT_ID_QUERY,
    knowledge_service: KnowledgeService = Depends(get_knowledge_service),
):
    """Enable or disable several chunks' vectors in one call."""
    try:
        result = await knowledge_service.bulk_toggle(bot_id, request.chunk_ids, request.enabled)
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except Exception as e:
        logger.error(f"Bulk toggle failed for bot {bot_id}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    return BulkChunkOperationResponse(success=True, **result)


@router.delete("/chunks/{chunk_id}", response_model=DeleteChunkResponse)
async def delete_chunk(
    chunk_id: str,
    bot_id: str = BOT_ID_QUERY,
    knowledge_service: KnowledgeService = Depends(get_knowledge_service),
):
    """Delete one chunk's vector.

    `deleted: false` is a 404: the row is either unknown or another bot's, and the
    two are indistinguishable to the caller by design.
    """
    try:
        deleted = await knowledge_service.delete_chunk(bot_id, chunk_id)
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except Exception as e:
        logger.error(f"Delete failed for chunk {chunk_id}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chunk not found.")

    return DeleteChunkResponse(success=True, chunk_id=chunk_id, deleted=True)


@router.delete("/sources/bulk", response_model=BulkDeleteSourcesResponse)
async def bulk_delete_source_vectors(
    request: BulkDeleteSourcesRequest,
    bot_id: str = BOT_ID_QUERY,
    vector_store: VectorStoreService = Depends(get_vector_store_service),
):
    """Delete the vectors of several sources at once.

    Declared before `/sources/{source_id}` so the literal path "bulk" is not captured as a
    source id.

    This is what "delete all FAQ entries" calls. It must not be confused with
    `DELETE /{bot_id}`, which clears every vector the bot owns: a bot's vectors come from
    both uploaded documents and FAQ entries, so deleting by bot would take the documents'
    vectors with the FAQs' and leave the server's `knowledge_chunks_meta` rows describing
    vectors that no longer exist. The caller names the sources it means.
    """
    try:
        deleted = await vector_store.delete_by_sources(bot_id, request.source_ids)
        return BulkDeleteSourcesResponse(
            success=True,
            bot_id=bot_id,
            requested=len(request.source_ids),
            chunks_deleted=deleted,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except Exception as e:
        logger.error(f"Bulk source delete failed for bot {bot_id}: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.delete("/sources/{source_id}")
async def delete_source_vectors(
    source_id: str,
    bot_id: str = BOT_ID_QUERY,
    vector_store: VectorStoreService = Depends(get_vector_store_service),
):
    """Delete every vector belonging to one knowledge source.

    Called when a source is deleted on the server. Prisma's cascade removes the
    `knowledge_sources` row and its `knowledge_chunks_meta` children, but it cannot
    reach these vectors: they live in a different PostgreSQL database on a different
    port. Without this call the vectors outlive the source and keep being retrieved
    for a document the user deleted.
    """
    try:
        deleted = await vector_store.delete_by_source(bot_id, source_id)
        return {"success": True, "bot_id": bot_id, "source_id": source_id, "chunks_deleted": deleted}
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except Exception as e:
        logger.error(f"Delete failed for source {source_id}: {e}")
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
