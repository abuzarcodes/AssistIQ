"""Multi-tenant context retriever interface for vector similarity search."""

from typing import List, Optional
from app.schemas.ai import SourceDocument
from app.services.retrieval_service import RetrievalService, get_retrieval_service


class RAGRetriever:
    """Retriever coordinating query embedding and vector search scoped to bot_id."""

    def __init__(self, retrieval_service: Optional[RetrievalService] = None) -> None:
        self.retrieval_service = retrieval_service or get_retrieval_service()

    async def get_relevant_documents(
        self,
        query: str,
        bot_id: str,
        workspace_id: Optional[str] = None,
        top_k: int = 4,
    ) -> List[SourceDocument]:
        """Fetch top relevant document chunks for user query scoped strictly to tenant bot."""
        return await self.retrieval_service.search_context(
            query=query,
            bot_id=bot_id,
            workspace_id=workspace_id,
            top_k=top_k,
        )
