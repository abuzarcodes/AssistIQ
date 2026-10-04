"""Vector Store Service using PostgreSQL and pgvector."""

import json
from typing import List, Dict, Any, Optional
import asyncpg
from app.core.config import settings
from app.core.logging import logger, format_log_context


class VectorStoreService:
    """Service layer for pgvector operations."""

    def __init__(self):
        self.db_url = settings.DATABASE_URL
        self.table_name = settings.VECTOR_STORE_TABLE
        self.dimension = settings.EMBEDDING_DIMENSION
        self.pool: Optional[asyncpg.Pool] = None

    async def connect(self) -> None:
        """Initialize database connection pool and ensure table exists."""
        if self.pool is None:
            try:
                self.pool = await asyncpg.create_pool(self.db_url)
                await self.ensure_table()
                logger.info("Successfully connected to vector database")
            except Exception as e:
                logger.error(f"Failed to connect to vector database: {e}")
                raise

    async def disconnect(self) -> None:
        """Close database connection pool."""
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    async def ensure_table(self) -> None:
        """Create the vector extension and table if they don't exist."""
        if not self.pool:
            return

        async with self.pool.acquire() as conn:
            # Ensure pgvector extension exists
            await conn.execute("CREATE EXTENSION IF NOT EXISTS vector;")
            
            # Create table
            query = f"""
            CREATE TABLE IF NOT EXISTS {self.table_name} (
                id TEXT PRIMARY KEY,
                bot_id TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding vector({self.dimension}),
                topic TEXT,
                source_id TEXT,
                chunk_index INTEGER DEFAULT 0,
                metadata JSONB DEFAULT '{{}}'::jsonb,
                created_at TIMESTAMP DEFAULT NOW()
            );
            """
            await conn.execute(query)

            # Additive column for enable/disable. `ADD COLUMN IF NOT EXISTS` so an
            # existing table gains it on startup without a manual migration; existing
            # rows default to enabled, which is the correct backfill.
            await conn.execute(
                f"ALTER TABLE {self.table_name} ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true;"
            )

            # Create index on bot_id for multi-tenant isolation performance
            await conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{self.table_name}_bot_id ON {self.table_name}(bot_id);")

            # Supports the retrieval filter (`bot_id = $ AND enabled = true`).
            await conn.execute(
                f"CREATE INDEX IF NOT EXISTS idx_{self.table_name}_bot_enabled "
                f"ON {self.table_name}(bot_id, enabled);"
            )

    async def add_documents(
        self, bot_id: str, chunks: List[Dict[str, Any]], embeddings: List[List[float]]
    ) -> int:
        """Batch insert document chunks and embeddings.

        Raises rather than returning 0 when the store cannot accept the write. A silent 0
        is indistinguishable from "there was nothing to insert", which turns an unreachable
        database into a success report — see the note on `connect()` failing at startup.
        """
        if not chunks:
            # Genuinely nothing to do — the only case where 0 is an honest answer.
            return 0

        if not self.pool:
            raise RuntimeError(
                "Vector store is not connected. Check DATABASE_URL in the AI service .env and "
                "that the pgvector database is running (see app/Ai/docker-compose.yml)."
            )

        if len(chunks) != len(embeddings):
            raise ValueError(
                f"Refusing to store: {len(chunks)} chunks but {len(embeddings)} embeddings."
            )

        query = f"""
        INSERT INTO {self.table_name} 
        (id, bot_id, content, embedding, topic, source_id, chunk_index, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding,
        topic = EXCLUDED.topic,
        metadata = EXCLUDED.metadata;
        """
        
        records = []
        for chunk, emb in zip(chunks, embeddings):
            records.append((
                chunk["id"],
                bot_id,
                chunk["content"],
                str(emb), # asyncpg handles vector strings or lists
                chunk.get("topic", "GENERAL_SUPPORT"),
                chunk.get("source_id", ""),
                chunk.get("metadata", {}).get("chunk_index", 0),
                json.dumps(chunk.get("metadata", {}))
            ))

        async with self.pool.acquire() as conn:
            async with conn.transaction():
                await conn.executemany(query, records)
                
        return len(records)

    async def search(
        self, query_embedding: List[float], bot_id: str, top_k: int = 3, topic_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Perform similarity search isolated by bot_id."""
        if not self.pool:
            return []

        # Cosine distance operator <=> in pgvector
        # Similarity = 1 - distance
        
        base_query = f"""
        SELECT
            id, content, topic, source_id, metadata,
            1 - (embedding <=> $1) AS score
        FROM {self.table_name}
        WHERE bot_id = $2 AND enabled = true
        """

        args = [str(query_embedding), bot_id]
        
        if topic_filter:
            base_query += " AND topic = $3"
            args.append(topic_filter)
            
        base_query += f" ORDER BY embedding <=> $1 LIMIT ${len(args) + 1}"
        args.append(top_k)

        async with self.pool.acquire() as conn:
            rows = await conn.fetch(base_query, *args)
            
        results = []
        for row in rows:
            results.append({
                "id": row["id"],
                "content": row["content"],
                "topic": row["topic"],
                # Selected so a citation can name the document an answer came from. The
                # column has always existed and `add_documents` has always written it; it
                # was simply not projected here, because nothing needed it until sources.
                "source_id": row["source_id"],
                "metadata": json.loads(row["metadata"]) if isinstance(row["metadata"], str) else row["metadata"],
                "score": float(row["score"])
            })

        return results

    def _require_pool(self, operation: str) -> None:
        """Fail loudly when the store is unavailable.

        Chunk mutations must not report success against a disconnected pool. A
        caller that gets `False` from `toggle_chunk` can tell the difference
        between "no such chunk" and "the database is down" only if this raises
        instead of the method quietly returning a falsy value.
        """
        if not self.pool:
            raise RuntimeError(
                f"Cannot {operation}: vector store is not connected. Check DATABASE_URL in "
                "the AI service .env and that the pgvector database is running "
                "(see app/Ai/docker-compose.yml)."
            )

    @staticmethod
    def _row_to_chunk(row: asyncpg.Record, include_embedding: bool = False) -> Dict[str, Any]:
        """Shape a pgvector row into the dict the API layer returns."""
        metadata = row["metadata"]
        chunk = {
            "id": row["id"],
            "bot_id": row["bot_id"],
            "content": row["content"],
            "topic": row["topic"],
            "source_id": row["source_id"],
            "chunk_index": row["chunk_index"],
            "enabled": row["enabled"],
            "metadata": json.loads(metadata) if isinstance(metadata, str) else (metadata or {}),
        }
        if include_embedding:
            chunk["embedding"] = row["embedding"]
        return chunk

    async def get_chunk(self, chunk_id: str, bot_id: str) -> Optional[Dict[str, Any]]:
        """Fetch one chunk, scoped to its bot.

        The `bot_id` predicate is not optional. Without it a caller holding a
        chunk id from one workspace could read or mutate another workspace's
        knowledge by guessing an id.
        """
        self._require_pool("read chunk")

        query = f"""
        SELECT id, bot_id, content, topic, source_id, chunk_index, metadata, enabled
        FROM {self.table_name}
        WHERE id = $1 AND bot_id = $2;
        """
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(query, chunk_id, bot_id)

        return self._row_to_chunk(row) if row else None

    async def get_chunks_by_ids(self, bot_id: str, chunk_ids: List[str]) -> List[Dict[str, Any]]:
        """Fetch several chunks at once, scoped to their bot.

        Used by re-embed and bulk operations, which need each chunk's current
        content before they can re-encode it. Ordering is unspecified — callers
        key by id.
        """
        if not chunk_ids:
            return []
        self._require_pool("read chunks")

        query = f"""
        SELECT id, bot_id, content, topic, source_id, chunk_index, metadata, enabled
        FROM {self.table_name}
        WHERE bot_id = $1 AND id = ANY($2::text[]);
        """
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(query, bot_id, list(chunk_ids))

        return [self._row_to_chunk(row) for row in rows]

    async def update_chunk(
        self,
        chunk_id: str,
        bot_id: str,
        content: Optional[str] = None,
        embedding: Optional[List[float]] = None,
        topic: Optional[str] = None,
        metadata_updates: Optional[Dict[str, Any]] = None,
    ) -> bool:
        """Update a chunk's content, embedding, topic and/or metadata in place.

        Only the arguments that are not None are written, so a caller toggling
        content does not have to re-supply the topic. Returns False when no row
        matched, which the API layer turns into a 404 — never a silent success.
        """
        self._require_pool("update chunk")

        assignments: List[str] = []
        args: List[Any] = [chunk_id, bot_id]

        if content is not None:
            args.append(content)
            assignments.append(f"content = ${len(args)}")
        if embedding is not None:
            args.append(str(embedding))
            assignments.append(f"embedding = ${len(args)}")
        if topic is not None:
            args.append(topic)
            assignments.append(f"topic = ${len(args)}")
        if metadata_updates:
            # `||` merges keys rather than replacing the object, so per-chunk
            # metadata written at ingestion survives a later re-embed.
            args.append(json.dumps(metadata_updates))
            assignments.append(f"metadata = COALESCE(metadata, '{{}}'::jsonb) || ${len(args)}::jsonb")

        if not assignments:
            # Nothing to write — report whether the chunk exists rather than
            # issuing an empty UPDATE, which would be valid SQL and misleading.
            return await self.get_chunk(chunk_id, bot_id) is not None

        query = f"""
        UPDATE {self.table_name}
        SET {', '.join(assignments)}
        WHERE id = $1 AND bot_id = $2;
        """
        async with self.pool.acquire() as conn:
            status = await conn.execute(query, *args)

        try:
            return int(status.split(" ")[1]) > 0
        except (IndexError, ValueError):
            return False

    async def toggle_chunk(self, chunk_id: str, bot_id: str, enabled: bool) -> Optional[Dict[str, Any]]:
        """Enable or disable one chunk. Returns the updated chunk, or None if absent."""
        self._require_pool("toggle chunk")

        query = f"""
        UPDATE {self.table_name}
        SET enabled = $3
        WHERE id = $1 AND bot_id = $2
        RETURNING id, bot_id, content, topic, source_id, chunk_index, metadata, enabled;
        """
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(query, chunk_id, bot_id, enabled)

        return self._row_to_chunk(row) if row else None

    async def delete_chunk(self, chunk_id: str, bot_id: str) -> bool:
        """Delete one chunk. Returns False when it did not exist (or was another bot's)."""
        self._require_pool("delete chunk")

        query = f"DELETE FROM {self.table_name} WHERE id = $1 AND bot_id = $2;"
        async with self.pool.acquire() as conn:
            status = await conn.execute(query, chunk_id, bot_id)

        try:
            return int(status.split(" ")[1]) > 0
        except (IndexError, ValueError):
            return False

    async def bulk_toggle(self, bot_id: str, chunk_ids: List[str], enabled: bool) -> int:
        """Enable or disable many chunks at once. Returns how many rows changed."""
        if not chunk_ids:
            return 0
        self._require_pool("bulk toggle chunks")

        query = f"""
        UPDATE {self.table_name}
        SET enabled = $3
        WHERE bot_id = $1 AND id = ANY($2::text[]);
        """
        async with self.pool.acquire() as conn:
            status = await conn.execute(query, bot_id, list(chunk_ids), enabled)

        try:
            return int(status.split(" ")[1])
        except (IndexError, ValueError):
            return 0

    async def bulk_delete(self, bot_id: str, chunk_ids: List[str]) -> int:
        """Delete many chunks at once. Returns how many rows were removed."""
        if not chunk_ids:
            return 0
        self._require_pool("bulk delete chunks")

        query = f"DELETE FROM {self.table_name} WHERE bot_id = $1 AND id = ANY($2::text[]);"
        async with self.pool.acquire() as conn:
            status = await conn.execute(query, bot_id, list(chunk_ids))

        try:
            return int(status.split(" ")[1])
        except (IndexError, ValueError):
            return 0

    async def delete_by_source(self, bot_id: str, source_id: str) -> int:
        """Delete every vector belonging to one knowledge source.

        The server deletes the `knowledge_sources` row inside a Prisma cascade,
        but that cascade stops at the database boundary — the vectors live in a
        different database on a different port. This is the explicit second half
        of that deletion; without it the vectors survive as orphans and keep
        being retrieved for a source the user believes is gone.
        """
        self._require_pool("delete source vectors")

        query = f"DELETE FROM {self.table_name} WHERE bot_id = $1 AND source_id = $2;"
        async with self.pool.acquire() as conn:
            status = await conn.execute(query, bot_id, source_id)

        try:
            return int(status.split(" ")[1])
        except (IndexError, ValueError):
            return 0

    async def delete_by_sources(self, bot_id: str, source_ids: List[str]) -> int:
        """Delete the vectors of several sources in one statement.

        Exists for "delete all FAQ entries", which is **not** the same as
        `delete_by_bot`. A bot's vectors come from two places — uploaded documents and
        hand-written FAQ entries — and they share one table, distinguished only by
        `source_id`. Deleting by bot would take the documents' vectors with the FAQs',
        leaving `knowledge_chunks_meta` rows on the server whose vectors no longer exist:
        the documents would survive in the UI and stop being searchable, with nothing in
        either database recording why. Scoping to the FAQ entries' own ids removes exactly
        what was asked for.
        """
        if not source_ids:
            return 0
        self._require_pool("delete source vectors")

        query = f"DELETE FROM {self.table_name} WHERE bot_id = $1 AND source_id = ANY($2::text[]);"
        async with self.pool.acquire() as conn:
            status = await conn.execute(query, bot_id, list(source_ids))

        try:
            return int(status.split(" ")[1])
        except (IndexError, ValueError):
            return 0

    async def count_by_bot(self, bot_id: str, enabled_only: bool = False) -> int:
        """Count a bot's vectors, optionally only the enabled ones."""
        self._require_pool("count chunks")

        query = f"SELECT COUNT(*) FROM {self.table_name} WHERE bot_id = $1"
        if enabled_only:
            query += " AND enabled = true"
        query += ";"

        async with self.pool.acquire() as conn:
            return await conn.fetchval(query, bot_id)

    async def delete_by_bot(self, bot_id: str) -> int:
        """Delete all vectors for a specific bot."""
        if not self.pool:
            return 0
            
        query = f"DELETE FROM {self.table_name} WHERE bot_id = $1;"
        async with self.pool.acquire() as conn:
            status = await conn.execute(query, bot_id)
            
        # status looks like "DELETE N"
        try:
            return int(status.split(" ")[1])
        except (IndexError, ValueError):
            return 0

    async def get_stats(self) -> Dict[str, Any]:
        """Get statistics about the vector store."""
        if not self.pool:
            return {"status": "disconnected"}
            
        async with self.pool.acquire() as conn:
            total_count = await conn.fetchval(f"SELECT COUNT(*) FROM {self.table_name};")
            bots_count = await conn.fetchval(f"SELECT COUNT(DISTINCT bot_id) FROM {self.table_name};")
            
        return {
            "status": "connected",
            "total_chunks": total_count,
            "bots_indexed": bots_count,
            "details": {
                "table": self.table_name,
                "dimension": self.dimension
            }
        }


_vector_store_service_instance = None


def get_vector_store_service() -> VectorStoreService:
    """Dependency injector for VectorStoreService singleton."""
    global _vector_store_service_instance
    if _vector_store_service_instance is None:
        _vector_store_service_instance = VectorStoreService()
    return _vector_store_service_instance
