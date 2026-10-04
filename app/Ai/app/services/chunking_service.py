"""Chunking Service for RAG pipeline."""

import uuid
from typing import Callable, List, Dict, Any, Optional

from app.core.config import settings
from app.rag.ingestion.chunker import TextChunker
from app.core.logging import logger, format_log_context


class ChunkingService:
    """Service layer for text chunking operations."""

    def __init__(self):
        self.chunk_size = settings.CHUNK_SIZE
        self.chunk_overlap = settings.CHUNK_OVERLAP
        self.chunker = TextChunker(chunk_size=self.chunk_size, chunk_overlap=self.chunk_overlap)
        self.max_chunks_per_source = settings.AI_MAX_CHUNKS_PER_SOURCE

    def create_chunks(self, bot_id: str, entry_id: str, topic: str, content: str) -> List[Dict[str, Any]]:
        """Split FAQ/entry content into chunks with deterministic ids.

        Deterministic ids (`{bot_id}_{entry_id}_chunk_{i}`) are load-bearing on this
        path: re-ingesting an edited entry lands on the same primary keys, so
        `ON CONFLICT (id) DO UPDATE` replaces the old chunks instead of inserting a
        second copy alongside them. Changing this to UUIDs would silently duplicate
        every edited FAQ answer in the vector store.

        Document ingestion deliberately does NOT use this method — see
        `create_document_chunks`.
        """
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

    def create_document_chunks(
        self,
        bot_id: str,
        source_id: str,
        text: str,
        topic: Optional[str] = None,
        page_resolver: Optional[Callable[[int], Optional[int]]] = None,
    ) -> List[Dict[str, Any]]:
        """Split extracted document text into chunks with page provenance.

        Ids are freshly generated UUIDs, not derived from the source. A document
        source is replaced wholesale on re-upload — the old rows are deleted before
        the new ones are written — so there is nothing for a deterministic id to
        collide with, and reusing one would let a stale chunk survive a re-upload
        that produced fewer chunks.

        Args:
            page_resolver: Maps a character offset in ``text`` to a page number.
                Supplied by the document extractor, which is the only component
                that knows where the page boundaries fell. Omit it for formats
                with no page concept; chunks then carry ``page_number=None``.
        """
        chunks_with_offsets = self.chunker.split_text_with_offsets(text)

        if len(chunks_with_offsets) > self.max_chunks_per_source:
            raise ValueError(
                f"Document would produce {len(chunks_with_offsets)} chunks, above this "
                f"service's ceiling of {self.max_chunks_per_source}. Raise "
                "AI_MAX_CHUNKS_PER_SOURCE or split the document."
            )

        total = len(chunks_with_offsets)
        processed_chunks = []

        for i, (start, end, chunk_text) in enumerate(chunks_with_offsets):
            page_number = page_resolver(start) if page_resolver else None

            metadata = {
                "bot_id": bot_id,
                "source_id": source_id,
                "topic": topic,
                "chunk_index": i,
                "total_chunks": total,
                "page_number": page_number,
                "char_start": start,
                "char_end": end,
            }

            processed_chunks.append({
                "id": str(uuid.uuid4()),
                "content": chunk_text,
                "metadata": metadata,
                "topic": topic,
                "bot_id": bot_id,
                "source_id": source_id,
                "page_number": page_number,
            })

        logger.info(
            f"Created {total} chunks for document source {source_id}",
            extra=format_log_context(
                operation="create_document_chunks",
                bot_id=bot_id,
                source_id=source_id,
                num_chunks=total,
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
