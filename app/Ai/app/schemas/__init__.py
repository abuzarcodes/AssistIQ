"""Pydantic schemas for API request and response data validation."""

from app.schemas.common import ErrorDetail, StandardResponse
from app.schemas.ai import AIChatRequest, AIChatResponse, AIStatusResponse, SourceDocument
from app.schemas.classifier import ClassifyRequest, ClassifyResponse, IntentPrediction, ModelStatusResponse, EvaluationResponse
from app.schemas.knowledge import KnowledgeEntry, KnowledgeIngestRequest, KnowledgeIngestResponse
from app.schemas.rag import RAGSearchRequest, RAGSearchResult, RAGSearchResponse
from app.schemas.chat import ChatRequest, ChatResponse, PipelineDebugResponse
from app.schemas.testing import SystemStatusResponse, VectorStoreStats

__all__ = [
    "ErrorDetail",
    "StandardResponse",
    "AIChatRequest",
    "AIChatResponse",
    "AIStatusResponse",
    "SourceDocument",
    "ClassifyRequest",
    "ClassifyResponse",
    "IntentPrediction",
    "ModelStatusResponse",
    "EvaluationResponse",
    "KnowledgeEntry",
    "KnowledgeIngestRequest",
    "KnowledgeIngestResponse",
    "RAGSearchRequest",
    "RAGSearchResult",
    "RAGSearchResponse",
    "ChatRequest",
    "ChatResponse",
    "PipelineDebugResponse",
    "SystemStatusResponse",
    "VectorStoreStats",
]
