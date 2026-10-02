"""RAG (Retrieval-Augmented Generation) ingestion, retrieval, and generation module.

EXPERIMENTAL: ``RAGPipeline`` is not used by the production chat path. The production
RAG flow is ``app/services/rag_service.py`` + ``app/services/vector_store_service.py``.
(``app/rag/ingestion/chunker.py`` IS shared by the production chunking service.)
"""

from app.rag.pipeline import RAGPipeline

__all__ = ["RAGPipeline"]
