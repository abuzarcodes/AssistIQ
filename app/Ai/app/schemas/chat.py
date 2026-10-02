"""Schemas for Chat pipeline endpoints."""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from app.schemas.classifier import IntentPrediction


class ModelRef(BaseModel):
    """The catalog model a bot is assigned, as resolved by the Node backend.

    Node owns the catalog: it decides which provider/model pair a bot may use, and it
    builds this descriptor from the bot row — never from client input. This service
    validates `provider` against its adapter registry and passes `model_id` straight to
    that adapter; it holds no catalog and cannot second-guess the choice.

    Both fields are bounded because an unbounded string would reach a vendor SDK.
    """

    provider: str = Field(
        ...,
        min_length=1,
        max_length=64,
        description="Provider slug, matched against the adapter registry",
        example="openrouter",
    )
    model_id: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="The provider's own model identifier",
        example="openai/gpt-4o-mini",
    )


class ChatRequest(BaseModel):
    """Request payload for the main chat endpoint."""

    bot_id: str = Field(..., description="Unique ID of tenant bot", example="demo_bot_001")
    message: str = Field(..., description="User message/question", example="Can I get my money back?")
    model: Optional[ModelRef] = Field(
        default=None,
        description=(
            "Optional catalog model for this bot. Absent means the request runs on the "
            "service's environment-configured default — the behaviour of every request "
            "before the model catalog existed."
        ),
    )


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
