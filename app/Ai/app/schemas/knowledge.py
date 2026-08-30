"""Schemas for knowledge ingestion."""

from typing import List
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
