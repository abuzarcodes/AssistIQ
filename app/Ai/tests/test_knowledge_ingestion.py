"""Tests for knowledge ingestion — specifically that a store failure is never reported as success.

Regression cover for a real incident: `.env` pointed `DATABASE_URL` at a pgvector instance that
was not running, `connect()` failed at startup and left `pool = None`, and ingestion still logged
"Successfully ingested 0 chunks for bot ..." and returned `success: True` to the caller — the
backend recorded a completed ingestion for a bot with zero searchable knowledge.

The load-bearing assertion in every failure case below is the same: the word "Successfully" must
not appear in the logs.
"""

import logging
from contextlib import asynccontextmanager
from typing import Any, Dict, List

import pytest

from app.schemas.knowledge import KnowledgeEntry
from app.services.knowledge_service import KnowledgeService
from app.services.vector_store_service import VectorStoreService

BOT_ID = "bot_ingest_test"


class StubEmbedder:
    """Stand-in for the embedding provider so no model download or API call is needed."""

    def __init__(self, count_override: int | None = None) -> None:
        self.count_override = count_override
        self.calls: List[List[str]] = []

    async def embed_documents(self, texts: List[str]) -> List[List[float]]:
        self.calls.append(list(texts))
        count = self.count_override if self.count_override is not None else len(texts)
        return [[0.0] * 4 for _ in range(count)]


class FakeConnection:
    """Minimal asyncpg connection recording what `add_documents` writes."""

    def __init__(self, write_error: Exception | None = None) -> None:
        self.write_error = write_error
        self.written: List[tuple] = []

    async def executemany(self, query: str, records: Any) -> str:
        if self.write_error is not None:
            raise self.write_error
        self.written.extend(records)
        return f"INSERT 0 {len(records)}"

    @asynccontextmanager
    async def transaction(self):
        yield self


class FakePool:
    """Minimal asyncpg pool, enough for the `acquire()` / `transaction()` shape used here."""

    def __init__(self, write_error: Exception | None = None) -> None:
        self.conn = FakeConnection(write_error=write_error)

    @asynccontextmanager
    async def acquire(self):
        yield self.conn


def make_service(*, embedder: StubEmbedder | None = None) -> KnowledgeService:
    """Build a KnowledgeService with an isolated vector store and a stubbed embedder."""
    service = KnowledgeService()
    # Replace the process-wide singleton so a pool set here never leaks into another test.
    service.vector_store = VectorStoreService()
    service.embedder = embedder or StubEmbedder()
    return service


def chunk_count(service: KnowledgeService) -> int:
    """How many chunks the real chunker produces for the fixture entry."""
    return len(
        service.chunker.create_chunks(
            bot_id=BOT_ID, entry_id=ENTRIES[0].id, topic=ENTRIES[0].topic, content=ENTRIES[0].content
        )
    )


ENTRIES = [
    KnowledgeEntry(
        id="faq_001",
        topic="REFUND",
        content="Refund requests are accepted within 7 days of purchase. " * 40,
    )
]


@pytest.mark.asyncio
async def test_ingest_fails_loudly_when_the_vector_store_is_disconnected(caplog):
    """The reported bug: a store that never connected must not report a successful ingestion."""
    service = make_service()
    assert service.vector_store.pool is None  # the state `connect()` leaves behind on failure

    with caplog.at_level(logging.INFO, logger="assistiq_ai"):
        result = await service.ingest_entries(BOT_ID, ENTRIES)

    assert result["success"] is False
    assert "Vector store unavailable" in result["error"]
    assert "successfully" not in caplog.text.lower(), (
        "ingestion reported success with an unreachable vector store:\n" + caplog.text
    )


@pytest.mark.asyncio
async def test_ingest_reports_failure_when_the_store_writes_fewer_chunks_than_expected(caplog):
    """A partial write is a failure too — it must not be rounded up to success."""
    service = make_service()
    total = chunk_count(service)

    async def partial_write(bot_id, chunks, embeddings) -> int:
        return len(chunks) - 1

    service.vector_store.add_documents = partial_write  # type: ignore[method-assign]

    with caplog.at_level(logging.INFO, logger="assistiq_ai"):
        result = await service.ingest_entries(BOT_ID, ENTRIES)

    assert result["success"] is False
    assert f"Stored {total - 1} of {total} chunks" in result["error"]
    assert "successfully" not in caplog.text.lower(), caplog.text


@pytest.mark.asyncio
async def test_ingest_succeeds_and_reports_the_count_actually_written(caplog):
    """The happy path still works, and `chunks_created` is the store's number, not an estimate."""
    service = make_service()
    pool = FakePool()
    service.vector_store.pool = pool  # type: ignore[assignment]

    with caplog.at_level(logging.INFO, logger="assistiq_ai"):
        result = await service.ingest_entries(BOT_ID, ENTRIES)

    assert result == {"success": True, "entries_processed": 1, "chunks_created": len(pool.conn.written)}
    assert len(pool.conn.written) > 1
    assert f"Successfully ingested {len(pool.conn.written)} chunks" in caplog.text


@pytest.mark.asyncio
async def test_add_documents_returns_zero_only_for_an_empty_batch():
    """0 is an honest answer for "nothing to insert" and a lie for "could not insert"."""
    store = VectorStoreService()
    assert store.pool is None

    assert await store.add_documents(BOT_ID, [], []) == 0

    with pytest.raises(RuntimeError, match="not connected"):
        await store.add_documents(BOT_ID, [{"id": "c1", "content": "x"}], [[0.0]])


@pytest.mark.asyncio
async def test_add_documents_refuses_a_chunk_embedding_count_mismatch():
    """Silently zipping mismatched lists would drop chunks; refuse instead."""
    store = VectorStoreService()
    store.pool = FakePool()  # type: ignore[assignment]

    with pytest.raises(ValueError, match="2 chunks but 1 embeddings"):
        await store.add_documents(
            BOT_ID,
            [{"id": "c1", "content": "x"}, {"id": "c2", "content": "y"}],
            [[0.0]],
        )


@pytest.mark.asyncio
async def test_add_documents_propagates_a_database_write_error(caplog):
    """A failed INSERT reaches the caller as a failed ingestion, not as zero chunks stored."""
    service = make_service()
    service.vector_store.pool = FakePool(  # type: ignore[assignment]
        write_error=RuntimeError("relation does not exist")
    )

    with caplog.at_level(logging.INFO, logger="assistiq_ai"):
        result = await service.ingest_entries(BOT_ID, ENTRIES)

    assert result["success"] is False
    assert "relation does not exist" in result["error"]
    assert "successfully" not in caplog.text.lower(), caplog.text
