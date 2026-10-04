"""Knowledge Ingestion Service."""

from typing import List, Dict, Any, Optional

from app.schemas.knowledge import KnowledgeEntry
from app.services.chunking_service import get_chunking_service
from app.services.document_service import get_document_service
from app.services.embedding_service import get_embedding_service
from app.services.vector_store_service import get_vector_store_service
from app.core.logging import logger, format_log_context


class KnowledgeService:
    """Coordinates the ingestion of knowledge into the vector store."""

    def __init__(self):
        self.chunker = get_chunking_service()
        self.embedder = get_embedding_service()
        self.vector_store = get_vector_store_service()
        self.documents = get_document_service()

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
        try:
            chunks_inserted = await self.vector_store.add_documents(bot_id, all_chunks, embeddings)
        except Exception as e:
            # Fail the ingestion loudly. Previously a disconnected vector store produced
            # "Successfully ingested 0 chunks" and `success: True`, so an unreachable
            # database was reported to the caller as a completed ingestion.
            logger.error(
                f"Failed to store {len(all_chunks)} chunks for bot {bot_id}: {e}",
                extra=format_log_context(
                    operation="ingest_knowledge",
                    bot_id=bot_id,
                    entries=len(entries),
                ),
            )
            return {"success": False, "error": f"Vector store unavailable: {e}"}

        if chunks_inserted != len(all_chunks):
            # Belt and braces: the store reports how many rows it wrote, so a partial write
            # is never mistaken for a complete one.
            logger.error(
                f"Stored {chunks_inserted} of {len(all_chunks)} chunks for bot {bot_id}",
                extra=format_log_context(
                    operation="ingest_knowledge",
                    bot_id=bot_id,
                    entries=len(entries),
                    chunks=chunks_inserted,
                ),
            )
            return {
                "success": False,
                "error": f"Stored {chunks_inserted} of {len(all_chunks)} chunks",
            }

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

    async def ingest_document(
        self,
        bot_id: str,
        source_id: str,
        filename: str,
        file_bytes: bytes,
        topic: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Extract, chunk, embed and store one uploaded document.

        Unlike the FAQ path, this reports every chunk it created so the server can
        mirror them as `knowledge_chunks_meta` rows. The two services keep separate
        databases, so the server cannot discover these ids any other way — without
        this list it would own source rows whose chunks it can never address.

        `source_id` is the server's `knowledge_sources` row id. It is stored as the
        vector's `source_id`, which is the only link back to that row and therefore
        the key that makes source deletion possible.

        Returns a result dict rather than raising for expected failures, so the route
        can return a structured error. Unexpected exceptions still propagate.
        """
        # 1. Extract — with provenance, so chunks can carry a page number.
        document = self.documents.extract_text_with_pages(file_bytes, filename)

        # 2. Chunk
        chunks = self.chunker.create_document_chunks(
            bot_id=bot_id,
            source_id=source_id,
            text=document.text,
            topic=topic,
            page_resolver=document.page_for_offset,
        )

        if not chunks:
            return {
                "success": False,
                "error": "Document produced no text chunks.",
                "pages_extracted": document.segment_count,
            }

        # 3. Embed. Strict: a placeholder vector would be stored as though the
        # document were searchable, and nothing downstream could tell the difference.
        embeddings = await self.embedder.embed_documents(
            [chunk["content"] for chunk in chunks], strict=True
        )

        if len(embeddings) != len(chunks):
            return {
                "success": False,
                "error": f"Embedding mismatch: {len(chunks)} chunks, {len(embeddings)} vectors.",
                "pages_extracted": document.segment_count,
            }

        # 4. Store
        try:
            stored = await self.vector_store.add_documents(bot_id, chunks, embeddings)
        except Exception as e:
            logger.error(
                f"Failed to store {len(chunks)} chunks for document '{filename}': {e}",
                extra=format_log_context(
                    operation="ingest_document", bot_id=bot_id, source_id=source_id
                ),
            )
            return {
                "success": False,
                "error": f"Vector store unavailable: {e}",
                "pages_extracted": document.segment_count,
            }

        if stored != len(chunks):
            return {
                "success": False,
                "error": f"Stored {stored} of {len(chunks)} chunks",
                "pages_extracted": document.segment_count,
            }

        model_info = self.embedder.get_model_info()

        logger.info(
            f"Ingested document '{filename}' for bot {bot_id}: "
            f"{document.segment_count} pages, {stored} chunks",
            extra=format_log_context(
                operation="ingest_document",
                bot_id=bot_id,
                source_id=source_id,
                pages=document.segment_count,
                num_chunks=stored,
            ),
        )

        return {
            "success": True,
            "pages_extracted": document.segment_count,
            "chunks_created": stored,
            "chunks": [
                {
                    "id": chunk["id"],
                    "chunk_index": chunk["metadata"]["chunk_index"],
                    "content": chunk["content"],
                    "page_number": chunk["page_number"],
                    "topic": chunk["topic"],
                }
                for chunk in chunks
            ],
            "embedding_model": model_info["model"],
            "embedding_dimension": model_info["dimension"],
        }

    async def re_embed_chunk(self, bot_id: str, chunk_id: str, content: str) -> Optional[Dict[str, Any]]:
        """Replace one chunk's text and vector.

        Returns None when the chunk does not belong to `bot_id`, which the route
        turns into a 404 — the same answer it gives for a chunk that does not exist,
        so the endpoint cannot be used to probe another tenant's chunk ids.

        Raises EmbeddingError subclasses on embedding failure. Nothing is written in
        that case: the existing vector is left untouched rather than replaced with a
        placeholder, because a zero vector is worse than stale text — it silently
        removes the chunk from every future search while still reporting success.
        """
        existing = await self.vector_store.get_chunk(chunk_id, bot_id)
        if existing is None:
            return None

        embedding = await self.embedder.embed_text(content, strict=True)
        model_info = self.embedder.get_model_info()

        updated = await self.vector_store.update_chunk(
            chunk_id=chunk_id,
            bot_id=bot_id,
            content=content,
            embedding=embedding,
            metadata_updates={
                "embedding_model": model_info["model"],
                "embedding_dimension": model_info["dimension"],
            },
        )

        if not updated:
            # The row was there a moment ago and is not now — deleted concurrently.
            return None

        logger.info(
            f"Re-embedded chunk {chunk_id} for bot {bot_id}",
            extra=format_log_context(
                operation="re_embed_chunk",
                bot_id=bot_id,
                chunk_id=chunk_id,
                model=model_info["model"],
            ),
        )

        return {
            "chunk_id": chunk_id,
            "embedding_model": model_info["model"],
            "embedding_dimension": model_info["dimension"],
        }

    async def toggle_chunk(self, bot_id: str, chunk_id: str, enabled: bool) -> Optional[Dict[str, Any]]:
        """Enable or disable one chunk's vector. None when it is not this bot's."""
        return await self.vector_store.toggle_chunk(chunk_id, bot_id, enabled)

    async def delete_chunk(self, bot_id: str, chunk_id: str) -> bool:
        """Delete one chunk's vector. False when it is not this bot's."""
        return await self.vector_store.delete_chunk(chunk_id, bot_id)

    async def bulk_toggle(self, bot_id: str, chunk_ids: List[str], enabled: bool) -> Dict[str, Any]:
        """Enable or disable many chunks at once."""
        affected = await self.vector_store.bulk_toggle(bot_id, chunk_ids, enabled)
        return {"requested": len(chunk_ids), "affected": affected}

    async def bulk_delete(self, bot_id: str, chunk_ids: List[str]) -> Dict[str, Any]:
        """Delete many chunks at once."""
        affected = await self.vector_store.bulk_delete(bot_id, chunk_ids)
        return {"requested": len(chunk_ids), "affected": affected}


_knowledge_service_instance = None


def get_knowledge_service() -> KnowledgeService:
    """Dependency injector for KnowledgeService singleton."""
    global _knowledge_service_instance
    if _knowledge_service_instance is None:
        _knowledge_service_instance = KnowledgeService()
    return _knowledge_service_instance
