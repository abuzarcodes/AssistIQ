"""Knowledge Ingestion Service."""

from typing import List, Dict, Any
from app.schemas.knowledge import KnowledgeEntry
from app.services.chunking_service import get_chunking_service
from app.services.embedding_service import get_embedding_service
from app.services.vector_store_service import get_vector_store_service
from app.core.logging import logger, format_log_context


class KnowledgeService:
    """Coordinates the ingestion of knowledge into the vector store."""

    def __init__(self):
        self.chunker = get_chunking_service()
        self.embedder = get_embedding_service()
        self.vector_store = get_vector_store_service()

    async def ingest_entries(self, bot_id: str, entries: List[KnowledgeEntry]) -> Dict[str, Any]:
        """Ingest a list of knowledge entries for a bot."""
        if not entries:
            return {"success": True, "entries_processed": 0, "chunks_created": 0}

        all_chunks = []
        
        # 1. Chunking
        for entry in entries:
            chunks = self.chunker.create_chunks(
                bot_id=bot_id,
                entry_id=entry.id,
                topic=entry.topic,
                content=entry.content
            )
            all_chunks.extend(chunks)

        if not all_chunks:
            return {"success": True, "entries_processed": len(entries), "chunks_created": 0}

        # 2. Embedding
        texts_to_embed = [chunk["content"] for chunk in all_chunks]
        embeddings = await self.embedder.embed_documents(texts_to_embed)

        if len(embeddings) != len(all_chunks):
            logger.error("Mismatch between chunks and embeddings count.")
            return {"success": False, "error": "Embedding mismatch"}

        # 3. Storage
        chunks_inserted = await self.vector_store.add_documents(bot_id, all_chunks, embeddings)

        logger.info(
            f"Successfully ingested {chunks_inserted} chunks for bot {bot_id}",
            extra=format_log_context(
                operation="ingest_knowledge",
                bot_id=bot_id,
                entries=len(entries),
                chunks=chunks_inserted
            ),
        )

        return {
            "success": True,
            "entries_processed": len(entries),
            "chunks_created": chunks_inserted
        }


_knowledge_service_instance = None


def get_knowledge_service() -> KnowledgeService:
    """Dependency injector for KnowledgeService singleton."""
    global _knowledge_service_instance
    if _knowledge_service_instance is None:
        _knowledge_service_instance = KnowledgeService()
    return _knowledge_service_instance
