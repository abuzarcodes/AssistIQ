"""Chunking Service for RAG pipeline."""

from typing import List, Dict, Any
from app.core.config import settings
from app.rag.ingestion.chunker import TextChunker
from app.core.logging import logger, format_log_context


class ChunkingService:
    """Service layer for text chunking operations."""

    def __init__(self):
        self.chunk_size = settings.CHUNK_SIZE
        self.chunk_overlap = settings.CHUNK_OVERLAP
        self.chunker = TextChunker(chunk_size=self.chunk_size, chunk_overlap=self.chunk_overlap)

    def create_chunks(self, bot_id: str, entry_id: str, topic: str, content: str) -> List[Dict[str, Any]]:
        """Split content into chunks and attach metadata."""
        raw_chunks = self.chunker.split_text(content)
        
        processed_chunks = []
        for i, chunk_text in enumerate(raw_chunks):
            # Create unique ID for the chunk
            chunk_id = f"{bot_id}_{entry_id}_chunk_{i}"
            
            metadata = {
                "bot_id": bot_id,
                "source_id": entry_id,
                "topic": topic,
                "chunk_index": i,
                "total_chunks": len(raw_chunks)
            }
            
            processed_chunks.append({
                "id": chunk_id,
                "content": chunk_text,
                "metadata": metadata,
                "topic": topic,
                "bot_id": bot_id,
                "source_id": entry_id
            })
            
        logger.info(
            f"Created {len(processed_chunks)} chunks for entry {entry_id}",
            extra=format_log_context(
                operation="create_chunks",
                bot_id=bot_id,
                entry_id=entry_id,
                num_chunks=len(processed_chunks)
            ),
        )
        
        return processed_chunks


_chunking_service_instance = None


def get_chunking_service() -> ChunkingService:
    """Dependency injector for ChunkingService singleton."""
    global _chunking_service_instance
    if _chunking_service_instance is None:
        _chunking_service_instance = ChunkingService()
    return _chunking_service_instance
