"""Retrieval Service placeholder supporting multi-tenant document context lookup.

EXPERIMENTAL / PLACEHOLDER: ``search_context`` returns a hardcoded mock document and
does NOT query pgvector. It exists only to keep the experimental LangGraph pipeline
(``POST /api/v1/ai/chat``) runnable. The production retrieval path is
``app/services/rag_service.py`` against ``app/services/vector_store_service.py``.
"""

from typing import List, Optional
from app.schemas.ai import SourceDocument
from app.core.logging import logger, format_log_context


class RetrievalService:
    """Service handling vector database search scoped by workspace and bot ID."""

    async def search_context(
        self,
        query: str,
        bot_id: str,
        workspace_id: Optional[str] = None,
        top_k: int = 4,
    ) -> List[SourceDocument]:
        """Search vector store for relevant document chunks scoped to bot_id.
        
        Note: Currently returns mock context until pgvector database connection is initialized.
        """
        logger.info(
            "Searching context for bot",
            extra=format_log_context(
                operation="search_context",
                bot_id=bot_id,
                query_length=len(query),
            ),
        )

        # Placeholder context document
        return [
            SourceDocument(
                document_id="doc_placeholder_001",
                content=f"Sample grounding context snippet relevant to bot '{bot_id}' for query: '{query}'.",
                score=0.95,
                metadata={"bot_id": bot_id, "workspace_id": workspace_id or "default"},
            )
        ]


_retrieval_service_instance: Optional[RetrievalService] = None


def get_retrieval_service() -> RetrievalService:
    """Dependency injector for RetrievalService singleton instance."""
    global _retrieval_service_instance
    if _retrieval_service_instance is None:
        _retrieval_service_instance = RetrievalService()
    return _retrieval_service_instance
