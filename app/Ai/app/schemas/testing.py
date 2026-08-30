"""Schemas for testing and status endpoints."""

from typing import Dict, Any
from pydantic import BaseModel, Field


class SystemStatusResponse(BaseModel):
    """System-wide status check response."""

    api: str = Field(default="healthy", description="API health status")
    ml_model: str = Field(..., description="ML Intent model status")
    vector_store: str = Field(..., description="Vector Store DB status")
    embedding_service: str = Field(..., description="Embedding provider status")
    llm: str = Field(..., description="LLM provider status")


class VectorStoreStats(BaseModel):
    """Statistics about the vector store."""

    status: str = Field(..., description="Connection status")
    total_chunks: int = Field(default=0, description="Total number of chunks across all bots")
    bots_indexed: int = Field(default=0, description="Number of distinct bots with knowledge")
    details: Dict[str, Any] = Field(default_factory=dict, description="Additional backend stats")
