"""Schemas for RAG test endpoints."""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field


class RAGSearchRequest(BaseModel):
    """Request payload for testing vector retrieval."""

    bot_id: str = Field(..., description="Unique ID of tenant bot", example="demo_bot_001")
    query: str = Field(..., description="Search query string", example="How long do refunds take?")
    top_k: int = Field(default=3, description="Number of results to retrieve")
    topic_filter: Optional[str] = Field(default=None, description="Optional topic to filter results by")


class RAGSearchResult(BaseModel):
    """Single vector search result."""
    
    content: str = Field(..., description="Retrieved chunk text content")
    score: float = Field(..., description="Similarity score")
    metadata: Dict[str, Any] = Field(..., description="Chunk metadata")


class RAGSearchResponse(BaseModel):
    """Response payload for testing vector retrieval."""

    query: str = Field(..., description="Original search query")
    results: List[RAGSearchResult] = Field(..., description="List of retrieved chunks")
