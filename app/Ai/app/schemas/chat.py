"""Schemas for Chat pipeline endpoints."""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from app.schemas.classifier import IntentPrediction


class ChatRequest(BaseModel):
    """Request payload for the main chat endpoint."""

    bot_id: str = Field(..., description="Unique ID of tenant bot", example="demo_bot_001")
    message: str = Field(..., description="User message/question", example="Can I get my money back?")


class IntentInfo(BaseModel):
    """Intent metadata in chat response."""
    predicted: str = Field(..., description="Predicted intent")
    confidence: float = Field(..., description="Confidence score")


class RetrievalInfo(BaseModel):
    """Retrieval metadata in chat response."""
    used_topic_filter: bool = Field(..., description="Whether a topic filter was applied based on intent")
    top_score: float = Field(..., description="Highest similarity score among retrieved chunks")
    documents_found: int = Field(..., description="Number of relevant documents found")


class ChatResponse(BaseModel):
    """Response payload for the main chat endpoint."""

    status: str = Field(..., description="Response status ('success' or 'error')")
    response: str = Field(..., description="Generated natural language response or fallback message")
    fallback_required: bool = Field(..., description="Whether the system had to fallback")
    
    intent: Optional[IntentInfo] = Field(default=None, description="Intent classification metadata")
    retrieval: Optional[RetrievalInfo] = Field(default=None, description="RAG retrieval metadata")
    reason: Optional[str] = Field(default=None, description="Reason code if fallback occurred")


# Testing/Debug Schemas

class PipelineDebugResponse(BaseModel):
    """Detailed response exposing all pipeline steps for debugging/demonstration."""

    input: Dict[str, str] = Field(..., description="Original input")
    classification: Dict[str, Any] = Field(..., description="Intent classification results")
    retrieval_strategy: Dict[str, Any] = Field(..., description="Strategy used for retrieval")
    retrieval_results: List[Dict[str, Any]] = Field(..., description="Raw retrieved chunks")
    retrieval_confidence: Dict[str, Any] = Field(..., description="Evaluation of retrieval strength")
    generation: Optional[Dict[str, Any]] = Field(default=None, description="LLM generation metadata")
    final_result: Dict[str, Any] = Field(..., description="Final response and fallback status")
