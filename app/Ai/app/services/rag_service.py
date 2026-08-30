"""RAG Retrieval Service."""

from typing import List, Dict, Any, Optional
from app.services.embedding_service import get_embedding_service
from app.services.vector_store_service import get_vector_store_service
from app.core.config import settings
from app.core.logging import logger, format_log_context


class RAGService:
    """Service layer for RAG retrieval operations."""

    def __init__(self):
        self.embedder = get_embedding_service()
        self.vector_store = get_vector_store_service()
        self.retrieval_threshold = settings.RETRIEVAL_CONFIDENCE_THRESHOLD

    async def search(
        self, query: str, bot_id: str, top_k: int = 3, topic_filter: Optional[str] = None
    ) -> Dict[str, Any]:
        """Perform a semantic search for relevant knowledge."""
        query_embedding = await self.embedder.embed_text(query)
        
        results = await self.vector_store.search(
            query_embedding=query_embedding,
            bot_id=bot_id,
            top_k=top_k,
            topic_filter=topic_filter
        )
        
        # Determine top score
        top_score = results[0]["score"] if results else 0.0
        
        # Check against threshold
        is_confident = top_score >= self.retrieval_threshold
        
        logger.info(
            f"RAG Search completed. Found {len(results)} chunks. Top score: {top_score:.2f}",
            extra=format_log_context(
                operation="rag_search",
                bot_id=bot_id,
                topic_filter=topic_filter,
                num_results=len(results),
                top_score=top_score,
                is_confident=is_confident
            ),
        )
        
        return {
            "query": query,
            "results": results,
            "top_score": top_score,
            "is_confident": is_confident,
            "used_topic_filter": topic_filter is not None
        }


_rag_service_instance = None


def get_rag_service() -> RAGService:
    """Dependency injector for RAGService singleton."""
    global _rag_service_instance
    if _rag_service_instance is None:
        _rag_service_instance = RAGService()
    return _rag_service_instance
