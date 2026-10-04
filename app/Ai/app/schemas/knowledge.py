"""Schemas for knowledge ingestion."""

from typing import List, Optional
from pydantic import BaseModel, Field


class KnowledgeEntry(BaseModel):
    """Structured knowledge entry (e.g. FAQ)."""

    id: str = Field(..., description="Unique entry ID", example="faq_001")
    topic: str = Field(..., description="Topic or category of the knowledge", example="REFUND")
    content: str = Field(..., description="Knowledge content/answer", example="Refund requests are accepted within 7 days of purchase.")


class KnowledgeIngestRequest(BaseModel):
    """Request payload for ingesting bot knowledge."""

    bot_id: str = Field(..., description="Unique ID of tenant bot", example="demo_bot_001")
    entries: List[KnowledgeEntry] = Field(..., description="List of knowledge entries to ingest")


class KnowledgeIngestResponse(BaseModel):
    """Response payload for knowledge ingestion."""

    success: bool = Field(..., description="Success flag")
    bot_id: str = Field(..., description="Tenant bot ID")
    entries_processed: int = Field(..., description="Number of entries processed")
    chunks_created: int = Field(..., description="Number of vector chunks created")
    status: str = Field(..., description="Ingestion status (e.g., 'completed')")


class DocumentIngestChunkDetail(BaseModel):
    """One chunk produced by a document ingestion.

    The server persists one `knowledge_chunks_meta` row per entry here. The `id` is
    the pgvector primary key, and is the only handle the two databases share — the
    server row and its vector live in different databases, so this id is what joins
    them.
    """

    id: str = Field(..., description="Vector store chunk ID")
    chunk_index: int = Field(..., description="Zero-based position within the source")
    content: str = Field(..., description="Chunk text, so the server can store it for listing")
    page_number: Optional[int] = Field(
        default=None,
        description="1-based page the chunk came from; null when the format has no pages",
    )
    topic: Optional[str] = Field(default=None, description="Topic/category assigned at ingestion")


class DocumentIngestResponse(BaseModel):
    """Response payload for document file ingestion."""

    success: bool = Field(..., description="Success flag")
    bot_id: str = Field(..., description="Tenant bot ID")
    filename: str = Field(..., description="Original uploaded filename")
    pages_extracted: int = Field(..., description="Number of pages/paragraphs extracted")
    chunks_created: int = Field(..., description="Number of vector chunks created")
    status: str = Field(..., description="Ingestion status (e.g., 'completed')")
    embedding_model: str = Field(..., description="Embedding model used for these vectors")
    embedding_dimension: int = Field(..., description="Dimension of the stored vectors")
    chunks: List[DocumentIngestChunkDetail] = Field(
        default_factory=list,
        description="Per-chunk detail, so the server can mirror them as metadata rows",
    )


class ReEmbedRequest(BaseModel):
    """Request payload for re-embedding a single chunk."""

    content: str = Field(..., min_length=1, description="New chunk text to embed and store")


class ReEmbedResponse(BaseModel):
    """Result of re-embedding one chunk."""

    success: bool = Field(..., description="Success flag")
    chunk_id: str = Field(..., description="Vector store chunk ID")
    embedding_model: str = Field(..., description="Embedding model used")
    embedding_dimension: int = Field(..., description="Dimension of the stored vector")


class ChunkToggleRequest(BaseModel):
    """Request payload for enabling/disabling one chunk."""

    enabled: bool = Field(..., description="Desired enabled state")


class ChunkToggleResponse(BaseModel):
    """Result of toggling one chunk."""

    success: bool = Field(..., description="Success flag")
    chunk_id: str = Field(..., description="Vector store chunk ID")
    enabled: bool = Field(..., description="Enabled state after the write")


class BulkChunkIdsRequest(BaseModel):
    """Request payload naming several chunks to act on."""

    chunk_ids: List[str] = Field(
        ..., min_length=1, description="Vector store chunk IDs to act on"
    )


class BulkChunkToggleRequest(BulkChunkIdsRequest):
    """Request payload for bulk enabling/disabling."""

    enabled: bool = Field(..., description="Desired enabled state for every named chunk")


class BulkChunkOperationResponse(BaseModel):
    """Result of a bulk chunk operation.

    `requested` is reported alongside the affected count so a caller can tell a
    complete operation from a partial one — ids that were never this bot's, or were
    already deleted, silently drop out of the affected count.
    """

    success: bool = Field(..., description="Success flag")
    requested: int = Field(..., description="How many chunk IDs the request named")
    affected: int = Field(..., description="How many rows the operation actually changed")


class DeleteChunkResponse(BaseModel):
    """Result of deleting one chunk."""

    success: bool = Field(..., description="Success flag")
    chunk_id: str = Field(..., description="Vector store chunk ID")
    deleted: bool = Field(..., description="Whether a row was actually removed")


class BulkDeleteSourcesRequest(BaseModel):
    """Request payload naming several `source_id`s whose vectors should be removed.

    Not a "delete everything for this bot" request. A bot's vectors come from both
    uploaded documents and FAQ entries, and they share one table, so the caller must
    name which ones it means — the FAQ path names its knowledge entry ids, and the
    documents are left searchable.
    """

    source_ids: List[str] = Field(
        ..., min_length=1, description="`source_id` values whose vectors should be deleted"
    )


class BulkDeleteSourcesResponse(BaseModel):
    """Result of a bulk source-vector deletion."""

    success: bool = Field(..., description="Success flag")
    bot_id: str = Field(..., description="Tenant bot ID")
    requested: int = Field(..., description="How many source IDs the request named")
    chunks_deleted: int = Field(..., description="How many vectors were actually removed")
