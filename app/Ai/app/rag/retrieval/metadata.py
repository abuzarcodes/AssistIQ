"""Metadata models for retrieved RAG chunks."""

from typing import Optional, Dict, Any
from pydantic import BaseModel, Field


class ChunkMetadata(BaseModel):
    """Metadata fields attached to vector chunks for filtering and tenant isolation."""

    chunk_id: str = Field(..., description="Unique chunk identifier")
    bot_id: str = Field(..., description="Tenant bot owner ID")
    workspace_id: Optional[str] = Field(default=None, description="Tenant workspace ID")
    document_id: str = Field(..., description="Parent document identifier")
    title: Optional[str] = Field(default=None, description="Document title")
    page: Optional[int] = Field(default=None, description="Source page number")
    extra: Dict[str, Any] = Field(default_factory=dict, description="Arbitrary additional metadata")
