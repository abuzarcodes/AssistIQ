"""AI Chat and status Pydantic schemas."""

from typing import Any, List, Optional
from pydantic import BaseModel, Field


class SourceDocument(BaseModel):
    """Schema representing a retrieved context source document."""

    document_id: str = Field(..., description="Unique document ID")
    content: str = Field(..., description="Snippet of retrieved content")
    score: float = Field(default=0.0, description="Similarity vector score")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Metadata payload")


class AIChatRequest(BaseModel):
    """Request model for AI interaction endpoint."""

    bot_id: str = Field(..., description="Unique ID of tenant bot", example="bot_123")
    conversation_id: str = Field(..., description="Unique ID of chat session", example="conv_456")
    message: str = Field(..., description="User question or input query", example="How do I reset my password?")
    workspace_id: Optional[str] = Field(default=None, description="Optional tenant workspace ID")


class AIChatResponse(BaseModel):
    """Response model for AI interaction endpoint."""

    answer: str = Field(..., description="Generated answer from RAG / LLM pipeline")
    intent: Optional[str] = Field(default=None, description="Classified intent tag")
    should_escalate: bool = Field(default=False, description="Flag indicating human escalation recommendation")
    confidence: float = Field(default=0.0, description="Overall confidence score between 0.0 and 1.0")
    sources: List[SourceDocument] = Field(default_factory=list, description="List of context sources used")


class AIStatusResponse(BaseModel):
    """Status overview response for AI service health and configured models."""

    service: str = Field(default="assistiq-ai", description="Service name")
    status: str = Field(default="operational", description="Operational status")
    llm_provider: str = Field(..., description="Configured LLM provider name")
    llm_configured: bool = Field(..., description="Whether LLM credentials are setup")
    embedding_provider: str = Field(..., description="Configured Embedding provider name")
    embedding_configured: bool = Field(..., description="Whether Embedding credentials are setup")
