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
            
            # Create index on bot_id for multi-tenant isolation performance
            await conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{self.table_name}_bot_id ON {self.table_name}(bot_id);")

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
            id, content, topic, metadata, 
            1 - (embedding <=> $1) AS score
        FROM {self.table_name}
        WHERE bot_id = $2
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
                "metadata": json.loads(row["metadata"]) if isinstance(row["metadata"], str) else row["metadata"],
                "score": float(row["score"])
            })
            
        return results

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
