"""Tests for knowledge management — chunk curation, page provenance, and safe re-embedding.

This suite covers Checkpoint 2 of the document knowledge implementation plan. The
load-bearing claims it exists to prove:

1. Retrieval cannot return a disabled chunk. Disabling is the user's only way to say
   "stop using this" without deleting, so a filter that silently fails to apply makes
   the control a lie.
2. Every chunk mutation is scoped to its owning bot. Ids are not secrets — the FAQ path
   derives them from the bot id — so an unscoped `WHERE id = $1` would let one tenant
   edit another's knowledge by constructing an id.
3. Re-embedding never replaces a working vector with a placeholder. A zero vector
   reports success while removing the chunk from every future search.
"""

import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

import pytest

from app.api.routes.knowledge import router as knowledge_router  # noqa: F401  (import side effect: route registration)
from app.core.config import settings
from app.rag.ingestion.chunker import TextChunker
from app.schemas.knowledge import ChunkToggleRequest, ReEmbedRequest
from app.services.chunking_service import ChunkingService
from app.services.document_service import DocumentService
from app.services.embedding_service import (
    EmbeddingFailedError,
    EmbeddingService,
    EmbeddingUnavailableError,
)
from app.services.knowledge_service import KnowledgeService, get_knowledge_service
from app.services.vector_store_service import VectorStoreService, get_vector_store_service
from app.main import app

BOT_ID = "bot_km_test"
OTHER_BOT_ID = "bot_someone_else"


# --------------------------------------------------------------------------------------
# Fakes
# --------------------------------------------------------------------------------------


class RecordingConnection:
    """asyncpg connection double that records every statement it is handed.

    Recording the SQL matters as much as the return value here: for `search()` and for
    the bot-scoped mutations, the assertion *is* about the query text. A method that
    returns the right shape while omitting `AND bot_id = $2` passes any test that only
    checks its return value.
    """

    def __init__(
        self,
        rows: Optional[List[Dict[str, Any]]] = None,
        status: str = "UPDATE 1",
        scalar: Any = 0,
    ) -> None:
        self.queries: List[tuple] = []
        self.rows = rows or []
        self.status = status
        self.scalar = scalar

    async def execute(self, query: str, *args) -> str:
        self.queries.append((query, args))
        return self.status

    async def fetchrow(self, query: str, *args):
        self.queries.append((query, args))
        if not self.rows:
            return None
        row = dict(self.rows[0])
        # A real `UPDATE ... SET enabled = $n ... RETURNING` echoes back what it was
        # given. Without this the double would report the pre-toggle state and the
        # test would be asserting against a stale fixture rather than the write.
        if "RETURNING" in query and "enabled = $" in query and isinstance(args[-1], bool):
            row["enabled"] = args[-1]
        return row

    async def fetch(self, query: str, *args):
        self.queries.append((query, args))
        return self.rows

    async def fetchval(self, query: str, *args):
        self.queries.append((query, args))
        return self.scalar

    @asynccontextmanager
    async def transaction(self):
        yield self

    def sql(self) -> str:
        """Every statement this connection saw, joined — for substring assertions."""
        return "\n".join(query for query, _ in self.queries)

    def args_for(self, fragment: str) -> tuple:
        """Positional args of the first statement containing `fragment`."""
        for query, args in self.queries:
            if fragment in query:
                return args
        raise AssertionError(f"no statement contained {fragment!r}; saw:\n{self.sql()}")


class FakePool:
    """asyncpg pool double wrapping one RecordingConnection."""

    def __init__(self, conn: Optional[RecordingConnection] = None) -> None:
        self.conn = conn or RecordingConnection()

    @asynccontextmanager
    async def acquire(self):
        yield self.conn


def connected_store(conn: Optional[RecordingConnection] = None) -> VectorStoreService:
    """A VectorStoreService whose pool is present, so methods reach the SQL layer."""
    store = VectorStoreService()
    store.pool = FakePool(conn)  # type: ignore[assignment]
    return store


class StubEmbedder:
    """Embedder double with controllable success and recorded calls."""

    def __init__(self, fail: Optional[Exception] = None) -> None:
        self.fail = fail
        self.texts: List[str] = []

    async def embed_text(self, text: str, strict: bool = False) -> List[float]:
        self.texts.append(text)
        if self.fail is not None:
            raise self.fail
        return [0.1, 0.2, 0.3, 0.4]

    async def embed_documents(self, texts: List[str], strict: bool = False) -> List[List[float]]:
        self.texts.extend(texts)
        if self.fail is not None:
            raise self.fail
        return [[0.1, 0.2, 0.3, 0.4] for _ in texts]

    def get_model_info(self) -> Dict[str, Any]:
        return {"provider": "stub", "model": "stub-model", "dimension": 4, "is_configured": True}


# --------------------------------------------------------------------------------------
# Retrieval must exclude disabled chunks
# --------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_filters_disabled_chunks_at_the_sql_level():
    """`enabled = false` must be filtered in the query, not after the fact.

    Filtering in Python would still fetch the row, and with `LIMIT top_k` applied
    before the filter the disabled chunks would consume result slots — so a bot with
    3 disabled chunks and top_k=3 would return nothing at all.
    """
    conn = RecordingConnection(rows=[])
    store = connected_store(conn)

    await store.search([0.1] * 4, BOT_ID, top_k=3)

    sql = conn.sql()
    assert "bot_id = $2 AND enabled = true" in sql, sql
    # The filter must precede the limit to be meaningful.
    assert sql.index("enabled = true") < sql.index("LIMIT")


@pytest.mark.asyncio
async def test_search_keeps_the_enabled_filter_when_a_topic_filter_is_applied():
    """The topic branch appends to the WHERE clause; it must not replace the filter."""
    conn = RecordingConnection(rows=[])
    store = connected_store(conn)

    await store.search([0.1] * 4, BOT_ID, top_k=2, topic_filter="REFUND")

    sql = conn.sql()
    assert "enabled = true" in sql
    assert "topic = $3" in sql


# --------------------------------------------------------------------------------------
# Chunk mutations are bot-scoped and fail loudly when disconnected
# --------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_toggle_chunk_scopes_the_update_to_the_owning_bot():
    conn = RecordingConnection(rows=[_chunk_row(enabled=False)])
    store = connected_store(conn)

    result = await store.toggle_chunk("chunk_1", BOT_ID, False)

    assert result["enabled"] is False
    assert "id = $1 AND bot_id = $2" in conn.sql(), conn.sql()
    assert conn.args_for("UPDATE") == ("chunk_1", BOT_ID, False)


@pytest.mark.asyncio
async def test_toggle_chunk_returns_none_when_the_chunk_is_not_this_bots():
    """A chunk belonging to another bot must be indistinguishable from a missing one."""
    store = connected_store(RecordingConnection(rows=[]))

    assert await store.toggle_chunk("chunk_of_another_bot", BOT_ID, False) is None


@pytest.mark.asyncio
async def test_delete_chunk_scopes_the_delete_to_the_owning_bot():
    conn = RecordingConnection(status="DELETE 1")
    store = connected_store(conn)

    assert await store.delete_chunk("chunk_1", BOT_ID) is True
    assert "WHERE id = $1 AND bot_id = $2" in conn.sql(), conn.sql()


@pytest.mark.asyncio
async def test_delete_chunk_reports_false_for_a_row_that_was_not_there():
    store = connected_store(RecordingConnection(status="DELETE 0"))

    assert await store.delete_chunk("already_gone", BOT_ID) is False


@pytest.mark.asyncio
async def test_bulk_toggle_reports_how_many_rows_changed():
    """`affected` must come from the database, not from `len(chunk_ids)`.

    Ids that are foreign or already deleted drop out silently; reporting the request
    length would tell the user 5 chunks were disabled when 2 were.
    """
    conn = RecordingConnection(status="UPDATE 2")
    store = connected_store(conn)

    affected = await store.bulk_toggle(BOT_ID, ["c1", "c2", "c3", "c4", "c5"], False)

    assert affected == 2
    assert "bot_id = $1 AND id = ANY($2::text[])" in conn.sql(), conn.sql()


@pytest.mark.asyncio
async def test_bulk_delete_reports_how_many_rows_changed():
    conn = RecordingConnection(status="DELETE 3")
    store = connected_store(conn)

    assert await store.bulk_delete(BOT_ID, ["c1", "c2", "c3"]) == 3
    assert "bot_id = $1 AND id = ANY($2::text[])" in conn.sql(), conn.sql()


@pytest.mark.asyncio
async def test_bulk_operations_short_circuit_on_an_empty_id_list():
    """No ids means no query — and no connection attempt to fail on."""
    store = VectorStoreService()
    assert store.pool is None  # would raise below if the guard were missing

    assert await store.bulk_toggle(BOT_ID, [], False) == 0
    assert await store.bulk_delete(BOT_ID, []) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "call",
    [
        lambda s: s.get_chunk("c1", BOT_ID),
        lambda s: s.get_chunks_by_ids(BOT_ID, ["c1"]),
        lambda s: s.update_chunk("c1", BOT_ID, content="new"),
        lambda s: s.toggle_chunk("c1", BOT_ID, True),
        lambda s: s.delete_chunk("c1", BOT_ID),
        lambda s: s.bulk_toggle(BOT_ID, ["c1"], True),
        lambda s: s.bulk_delete(BOT_ID, ["c1"]),
        lambda s: s.delete_by_source(BOT_ID, "src_1"),
        lambda s: s.count_by_bot(BOT_ID),
    ],
)
async def test_chunk_mutations_refuse_to_run_against_a_disconnected_store(call):
    """A disconnected pool must raise, not return a falsy value.

    `False` already means "no such chunk" to every caller. If a dropped connection
    also produced `False`, a toggle would be reported to the user as "chunk not
    found" while the real problem was the database — and the delete path would 404
    for a chunk sitting safely in the store.
    """
    store = VectorStoreService()
    assert store.pool is None

    with pytest.raises(RuntimeError, match="not connected"):
        await call(store)


@pytest.mark.asyncio
async def test_update_chunk_only_writes_the_fields_it_was_given():
    """An unset argument must not overwrite the stored value with NULL."""
    conn = RecordingConnection(status="UPDATE 1")
    store = connected_store(conn)

    await store.update_chunk("c1", BOT_ID, content="new text")

    sql = conn.sql()
    assert "content = $3" in sql
    assert "embedding" not in sql, "content-only edit must not clear the vector"
    assert "topic" not in sql


@pytest.mark.asyncio
async def test_update_chunk_merges_metadata_instead_of_replacing_it():
    """Per-chunk metadata written at ingestion must survive a later re-embed."""
    conn = RecordingConnection(status="UPDATE 1")
    store = connected_store(conn)

    await store.update_chunk("c1", BOT_ID, metadata_updates={"embedding_model": "m"})

    assert "||" in conn.sql(), "metadata must be merged with ||, not assigned"


@pytest.mark.asyncio
async def test_update_chunk_with_nothing_to_write_checks_existence_instead():
    """An empty UPDATE is valid SQL that changes nothing while reporting success."""
    conn = RecordingConnection(rows=[_chunk_row()])
    store = connected_store(conn)

    assert await store.update_chunk("c1", BOT_ID) is True
    assert "UPDATE" not in conn.sql()
    assert "SELECT" in conn.sql()


@pytest.mark.asyncio
async def test_delete_by_source_scopes_to_both_bot_and_source():
    """Source deletion must not be able to reach another tenant's vectors.

    `source_id` is a server-side row id. Two tenants can hold sources with similar
    ids, and the vector table has no foreign key to arbitrate — only this predicate.
    """
    conn = RecordingConnection(status="DELETE 7")
    store = connected_store(conn)

    assert await store.delete_by_source(BOT_ID, "src_1") == 7
    assert conn.args_for("DELETE") == (BOT_ID, "src_1")
    assert "WHERE bot_id = $1 AND source_id = $2" in conn.sql()


@pytest.mark.asyncio
async def test_count_by_bot_can_restrict_itself_to_enabled_chunks():
    conn = RecordingConnection(scalar=5)
    store = connected_store(conn)

    await store.count_by_bot(BOT_ID, enabled_only=True)
    assert "enabled = true" in conn.sql()

    conn2 = RecordingConnection(scalar=9)
    await connected_store(conn2).count_by_bot(BOT_ID)
    assert "enabled" not in conn2.sql()


@pytest.mark.asyncio
async def test_delete_by_sources_scopes_to_the_named_sources_not_the_whole_bot():
    """Deleting all FAQ entries must not become deleting all the bot's knowledge.

    Documents and FAQ entries share this table, separated only by `source_id`. A
    `delete_by_bot` here would take the uploaded documents' vectors as well, leaving the
    server's `knowledge_chunks_meta` rows describing vectors that no longer exist — the
    documents would still be listed and would have silently stopped being searchable.
    """
    conn = RecordingConnection(status="DELETE 12")
    store = connected_store(conn)

    assert await store.delete_by_sources(BOT_ID, ["entry_1", "entry_2"]) == 12

    sql = conn.sql()
    assert "WHERE bot_id = $1 AND source_id = ANY($2::text[])" in sql
    assert conn.args_for("DELETE") == (BOT_ID, ["entry_1", "entry_2"])


@pytest.mark.asyncio
async def test_delete_by_sources_issues_no_statement_for_an_empty_list():
    """No entries means no FAQ vectors — and `ANY('{}')` would still be a DELETE.

    It would match nothing, so the damage is nil, but a bot with no FAQs and a full
    document library should not have a write issued against its vector table at all.
    """
    conn = RecordingConnection()
    store = connected_store(conn)

    assert await store.delete_by_sources(BOT_ID, []) == 0
    assert conn.queries == []


def _chunk_row(**overrides) -> Dict[str, Any]:
    """A pgvector row shaped as asyncpg would return it."""
    row = {
        "id": "chunk_1",
        "bot_id": BOT_ID,
        "content": "text",
        "topic": "REFUND",
        "source_id": "src_1",
        "chunk_index": 0,
        "metadata": {},
        "enabled": True,
    }
    row.update(overrides)
    return row


# --------------------------------------------------------------------------------------
# Page provenance: offsets must survive assembly
# --------------------------------------------------------------------------------------


def test_document_assembly_records_the_span_each_page_landed_in():
    """Page numbers must come from offsets, never from searching for the text.

    Overlapping chunks and repeated boilerplate ("Page 2 of 10" footers, shared
    headers) make chunk text non-unique, so a text search attributes chunks to the
    wrong page. Recording where each segment landed is the only reliable mapping.
    """
    service = DocumentService()
    document = service._assemble([(1, "alpha"), (2, "bravo"), (3, "charlie")])

    assert document.text == "alpha\n\nbravo\n\ncharlie"
    assert document.segment_count == 3
    assert [span[2] for span in document.spans] == [1, 2, 3]

    # The spans must actually index into the assembled text.
    for start, end, page in document.spans:
        assert document.text[start:end].strip() != ""
        assert document.page_for_offset(start) == page


def test_page_lookup_attributes_a_chunk_by_its_start_offset():
    service = DocumentService()
    document = service._assemble([(1, "a" * 10), (2, "b" * 10)])

    assert document.page_for_offset(0) == 1
    assert document.page_for_offset(9) == 1
    # Offset 12 is inside the 2-char separator, which belongs to no page.
    assert document.page_for_offset(12) == 2
    assert document.page_for_offset(20) == 2


def test_page_lookup_is_none_for_formats_without_pages():
    """DOCX has no page concept; reporting a paragraph index as a page would be a fabrication."""
    service = DocumentService()
    document = service._assemble([(None, "para one"), (None, "para two")])

    assert document.page_for_offset(0) is None
    assert document.page_for_offset(20) is None


def test_page_lookup_on_an_empty_document_does_not_raise():
    assert DocumentService()._assemble([]).page_for_offset(0) is None


def test_extract_text_with_pages_threads_pdf_pages_through(monkeypatch):
    """The public extractor must return the page numbers the PDF reader produced."""
    service = DocumentService()
    monkeypatch.setattr(
        service,
        "_extract_pdf_segments",
        lambda file_bytes, filename: [(1, "first page"), (2, "second page")],
    )

    document = service.extract_text_with_pages(b"ignored", "doc.pdf")

    assert document.segment_count == 2
    assert document.text == "first page\n\nsecond page"
    assert document.page_for_offset(0) == 1
    assert document.page_for_offset(12) == 2


def test_extract_text_still_returns_the_legacy_tuple(monkeypatch):
    """The FAQ-era callers depend on this shape; it must not change."""
    service = DocumentService()
    monkeypatch.setattr(
        service,
        "_extract_docx_segments",
        lambda file_bytes, filename: [(None, "one"), (None, "two")],
    )

    assert service.extract_text(b"ignored", "doc.docx") == ("one\n\ntwo", 2)


def test_document_service_uses_the_configured_ceiling_not_a_literal():
    """The old hardcoded 10 MB was stricter than the operator-facing limit.

    A document the platform owner had explicitly allowed would still be rejected
    here, and the failure would look like a corrupt file rather than a limit.
    """
    service = DocumentService()

    assert service.max_file_size_bytes == settings.AI_MAX_FILE_SIZE_BYTES
    assert service.max_file_size_bytes != 10 * 1024 * 1024


def test_oversize_documents_are_rejected_with_the_limit_in_the_message():
    service = DocumentService()
    service.max_file_size_bytes = 1024  # 1 KB, so the test need not allocate 100 MB

    with pytest.raises(ValueError, match="exceeds the 0 MB limit"):
        service.extract_text_with_pages(b"x" * 2048, "doc.pdf")


def test_unsupported_extensions_are_rejected_before_anything_else():
    with pytest.raises(ValueError, match="Unsupported file type"):
        DocumentService().extract_text_with_pages(b"x", "notes.txt")


# --------------------------------------------------------------------------------------
# Chunk ids: deterministic for FAQ, unique for documents
# --------------------------------------------------------------------------------------


def make_chunker(size: int = 10, overlap: int = 2, max_chunks: Optional[int] = None) -> ChunkingService:
    service = ChunkingService()
    service.chunker = TextChunker(chunk_size=size, chunk_overlap=overlap)
    if max_chunks is not None:
        service.max_chunks_per_source = max_chunks
    return service


def test_faq_chunk_ids_stay_deterministic_so_re_ingestion_updates_in_place():
    """This is why the plan's blanket UUID switch was not applied to the FAQ path.

    `add_documents` writes with `ON CONFLICT (id) DO UPDATE`. Deterministic ids are
    what make an edited FAQ answer *replace* its chunks. With UUIDs every save would
    insert a second copy, and the stale answer would keep being retrieved alongside
    the new one — with no error and nothing to notice.
    """
    service = make_chunker()

    first = service.create_chunks(BOT_ID, "faq_001", "REFUND", "x" * 25)
    second = service.create_chunks(BOT_ID, "faq_001", "REFUND", "x" * 25)

    assert [c["id"] for c in first] == [c["id"] for c in second]
    assert first[0]["id"] == f"{BOT_ID}_faq_001_chunk_0"


def test_document_chunk_ids_are_unique_per_ingestion():
    """A re-upload must not be able to collide with a stale chunk.

    Documents are replaced wholesale, so a deterministic id would let a leftover row
    from a longer previous version survive a shorter re-upload.
    """
    service = make_chunker()

    first = service.create_document_chunks(BOT_ID, "src_1", "y" * 25)
    second = service.create_document_chunks(BOT_ID, "src_1", "y" * 25)

    first_ids = {c["id"] for c in first}
    assert len(first_ids) == len(first), "ids must be unique within one ingestion"
    assert first_ids.isdisjoint({c["id"] for c in second})
    for chunk_id in first_ids:
        uuid.UUID(chunk_id)  # raises if it is not a UUID


def test_document_chunks_carry_index_offsets_and_page_numbers():
    service = make_chunker(size=10, overlap=0)
    text = "a" * 10 + "b" * 10 + "c" * 10

    chunks = service.create_document_chunks(
        BOT_ID, "src_1", text, topic="MANUAL", page_resolver=lambda offset: offset // 10 + 1
    )

    assert [c["metadata"]["chunk_index"] for c in chunks] == [0, 1, 2]
    assert [c["page_number"] for c in chunks] == [1, 2, 3]
    assert [c["metadata"]["char_start"] for c in chunks] == [0, 10, 20]
    assert chunks[1]["content"] == "b" * 10
    # The recorded span must actually identify the chunk's text.
    for chunk in chunks:
        start = chunk["metadata"]["char_start"]
        end = chunk["metadata"]["char_end"]
        assert text[start:end] == chunk["content"]


def test_document_chunks_report_no_page_when_no_resolver_is_supplied():
    chunks = make_chunker(size=10, overlap=0).create_document_chunks(BOT_ID, "src_1", "z" * 15)

    assert all(chunk["page_number"] is None for chunk in chunks)


def test_document_chunking_refuses_to_exceed_the_absolute_ceiling():
    """A backstop against an unbounded embedding bill if the server's limit is mis-set."""
    service = make_chunker(size=1, overlap=0, max_chunks=5)

    with pytest.raises(ValueError, match="above this service's ceiling of 5"):
        service.create_document_chunks(BOT_ID, "src_1", "x" * 50)


# --------------------------------------------------------------------------------------
# Embedding: strict mode exists so re-embed can fail safely
# --------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lenient_embedding_still_returns_placeholders_when_unconfigured():
    """The FAQ path's existing behaviour is preserved deliberately."""
    embedder = EmbeddingService()
    embedder._is_configured = False
    embedder.dimension = 3

    assert await embedder.embed_text("hello") == [0.0, 0.0, 0.0]
    assert await embedder.embed_documents(["a", "b"]) == [[0.0] * 3, [0.0] * 3]


@pytest.mark.asyncio
async def test_strict_embedding_raises_when_no_provider_is_configured():
    embedder = EmbeddingService()
    embedder._is_configured = False

    with pytest.raises(EmbeddingUnavailableError, match="not configured"):
        await embedder.embed_text("hello", strict=True)

    with pytest.raises(EmbeddingUnavailableError, match="not configured"):
        await embedder.embed_documents(["a", "b"], strict=True)


@pytest.mark.asyncio
async def test_strict_embedding_raises_when_the_provider_call_fails(monkeypatch):
    """A provider error must reach the caller instead of becoming a zero vector."""
    embedder = EmbeddingService()
    embedder._is_configured = True
    embedder.provider = "openai"
    embedder.dimension = 3

    async def boom(text: str):
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(embedder, "_get_hf_model", lambda: None)
    import langchain_openai

    class ExplodingEmbeddings:
        def __init__(self, **kwargs) -> None:
            pass

        async def aembed_query(self, text: str):
            raise RuntimeError("provider exploded")

    monkeypatch.setattr(langchain_openai, "OpenAIEmbeddings", ExplodingEmbeddings)

    with pytest.raises(EmbeddingFailedError, match="provider exploded"):
        await embedder.embed_text("hello", strict=True)

    # And the lenient path still absorbs it, for the legacy FAQ flow.
    assert await embedder.embed_text("hello") == [0.0, 0.0, 0.0]


def test_model_info_reports_the_model_actually_used(monkeypatch):
    """With huggingface selected, the configured OpenAI model name is not what runs.

    Reporting the raw config value would label stored vectors with a model that never
    touched them — and `embedding_model` is precisely the field consulted when
    deciding whether a chunk needs re-embedding.
    """
    import app.services.embedding_service as module

    monkeypatch.setattr(settings, "EMBEDDING_PROVIDER", "huggingface")
    monkeypatch.setattr(settings, "EMBEDDING_MODEL", "text-embedding-3-small")
    embedder = module.EmbeddingService()

    info = embedder.get_model_info()

    assert info["model"] == "all-MiniLM-L6-v2"
    assert info["provider"] == "huggingface"
    assert info["dimension"] == 384
    assert info["is_configured"] is True


# --------------------------------------------------------------------------------------
# Re-embed: failure must leave the stored chunk alone
# --------------------------------------------------------------------------------------


def make_knowledge_service(store: VectorStoreService, embedder: Any) -> KnowledgeService:
    service = KnowledgeService()
    service.vector_store = store
    service.embedder = embedder
    return service


@pytest.mark.asyncio
async def test_re_embed_declines_a_chunk_that_belongs_to_another_bot():
    """Returns None, which the route renders as 404 — the same as a chunk that never existed."""
    store = connected_store(RecordingConnection(rows=[]))
    service = make_knowledge_service(store, StubEmbedder())

    assert await service.re_embed_chunk(BOT_ID, "someone_elses_chunk", "new text") is None


@pytest.mark.asyncio
async def test_re_embed_leaves_the_stored_vector_untouched_when_embedding_fails():
    """The central safety property: a failed re-embed must not corrupt the chunk.

    Writing a placeholder here would be worse than doing nothing. The chunk would
    still exist, still be enabled, and still be listed — while matching no query
    ever again, because every similarity to a zero vector is undefined or ties.
    """
    conn = RecordingConnection(rows=[_chunk_row()])
    store = connected_store(conn)
    service = make_knowledge_service(store, StubEmbedder(fail=EmbeddingFailedError("provider down")))

    with pytest.raises(EmbeddingFailedError):
        await service.re_embed_chunk(BOT_ID, "chunk_1", "new text")

    assert "UPDATE" not in conn.sql(), (
        "a failed embedding must not reach the database:\n" + conn.sql()
    )


@pytest.mark.asyncio
async def test_re_embed_writes_content_and_vector_and_reports_the_model():
    conn = RecordingConnection(rows=[_chunk_row()], status="UPDATE 1")
    store = connected_store(conn)
    embedder = StubEmbedder()
    service = make_knowledge_service(store, embedder)

    result = await service.re_embed_chunk(BOT_ID, "chunk_1", "corrected text")

    assert result == {
        "chunk_id": "chunk_1",
        "embedding_model": "stub-model",
        "embedding_dimension": 4,
    }
    assert embedder.texts == ["corrected text"]
    args = conn.args_for("UPDATE")
    assert args[0] == "chunk_1"
    assert args[1] == BOT_ID
    assert "corrected text" in args


@pytest.mark.asyncio
async def test_re_embed_reports_not_found_when_the_row_vanishes_mid_flight():
    """Deleted between the read and the write — still a 404, never a false success."""
    conn = RecordingConnection(rows=[_chunk_row()], status="UPDATE 0")
    service = make_knowledge_service(connected_store(conn), StubEmbedder())

    assert await service.re_embed_chunk(BOT_ID, "chunk_1", "new text") is None


# --------------------------------------------------------------------------------------
# HTTP surface
# --------------------------------------------------------------------------------------


@pytest.fixture
def override_services():
    """Swap the AI service's dependencies for doubles, and restore them afterwards."""
    store = connected_store(RecordingConnection(rows=[_chunk_row()]))
    knowledge = make_knowledge_service(store, StubEmbedder())

    app.dependency_overrides[get_knowledge_service] = lambda: knowledge
    app.dependency_overrides[get_vector_store_service] = lambda: store
    yield knowledge, store
    app.dependency_overrides.pop(get_knowledge_service, None)
    app.dependency_overrides.pop(get_vector_store_service, None)


@pytest.mark.asyncio
async def test_toggle_endpoint_returns_the_new_state(async_client, override_services):
    response = await async_client.patch(
        f"/api/v1/knowledge/chunks/chunk_1/toggle?bot_id={BOT_ID}",
        json={"enabled": False},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"success": True, "chunk_id": "chunk_1", "enabled": False}


@pytest.mark.asyncio
async def test_toggle_endpoint_404s_for_a_chunk_outside_the_bot(async_client):
    store = connected_store(RecordingConnection(rows=[]))
    app.dependency_overrides[get_knowledge_service] = lambda: make_knowledge_service(
        store, StubEmbedder()
    )
    try:
        response = await async_client.patch(
            f"/api/v1/knowledge/chunks/foreign/toggle?bot_id={BOT_ID}",
            json={"enabled": False},
        )
    finally:
        app.dependency_overrides.pop(get_knowledge_service, None)

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_toggle_endpoint_requires_a_bot_id(async_client, override_services):
    """Omitting the scope must be a validation error, not an unscoped mutation."""
    response = await async_client.patch(
        "/api/v1/knowledge/chunks/chunk_1/toggle", json={"enabled": False}
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_re_embed_endpoint_surfaces_an_embedding_outage_as_503(async_client):
    store = connected_store(RecordingConnection(rows=[_chunk_row()]))
    app.dependency_overrides[get_knowledge_service] = lambda: make_knowledge_service(
        store, StubEmbedder(fail=EmbeddingUnavailableError("no key"))
    )
    try:
        response = await async_client.post(
            f"/api/v1/knowledge/chunks/chunk_1/re-embed?bot_id={BOT_ID}",
            json={"content": "new"},
        )
    finally:
        app.dependency_overrides.pop(get_knowledge_service, None)

    assert response.status_code == 503
    assert "no key" in response.json()["detail"]


@pytest.mark.asyncio
async def test_re_embed_endpoint_surfaces_a_provider_failure_as_502(async_client):
    """Distinct from 503 so an operator can tell a missing key from a broken provider."""
    store = connected_store(RecordingConnection(rows=[_chunk_row()]))
    app.dependency_overrides[get_knowledge_service] = lambda: make_knowledge_service(
        store, StubEmbedder(fail=EmbeddingFailedError("upstream 500"))
    )
    try:
        response = await async_client.post(
            f"/api/v1/knowledge/chunks/chunk_1/re-embed?bot_id={BOT_ID}",
            json={"content": "new"},
        )
    finally:
        app.dependency_overrides.pop(get_knowledge_service, None)

    assert response.status_code == 502


@pytest.mark.asyncio
async def test_re_embed_endpoint_rejects_empty_content(async_client, override_services):
    response = await async_client.post(
        f"/api/v1/knowledge/chunks/chunk_1/re-embed?bot_id={BOT_ID}",
        json={"content": ""},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_delete_endpoint_reports_removal(async_client, override_services):
    _, store = override_services
    store.pool.conn.status = "DELETE 1"

    response = await async_client.delete(
        f"/api/v1/knowledge/chunks/chunk_1?bot_id={BOT_ID}"
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"success": True, "chunk_id": "chunk_1", "deleted": True}


@pytest.mark.asyncio
async def test_delete_endpoint_404s_when_no_row_matched(async_client, override_services):
    _, store = override_services
    store.pool.conn.status = "DELETE 0"

    response = await async_client.delete(
        f"/api/v1/knowledge/chunks/chunk_1?bot_id={BOT_ID}"
    )

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_bulk_delete_route_is_not_shadowed_by_the_single_chunk_route(
    async_client, override_services
):
    """`/chunks/bulk` must not be parsed as `/chunks/{chunk_id}` with id "bulk".

    Declaration order decides this, and getting it wrong produces a 404 for the wrong
    reason — plus a delete attempt against a chunk literally named "bulk".
    """
    _, store = override_services
    store.pool.conn.status = "DELETE 2"

    response = await async_client.request(
        "DELETE",
        f"/api/v1/knowledge/chunks/bulk?bot_id={BOT_ID}",
        json={"chunk_ids": ["c1", "c2", "c3"]},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"success": True, "requested": 3, "affected": 2}


@pytest.mark.asyncio
async def test_bulk_toggle_endpoint_reports_requested_and_affected(async_client, override_services):
    _, store = override_services
    store.pool.conn.status = "UPDATE 1"

    response = await async_client.post(
        f"/api/v1/knowledge/chunks/bulk-toggle?bot_id={BOT_ID}",
        json={"chunk_ids": ["c1", "c2"], "enabled": False},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"success": True, "requested": 2, "affected": 1}


@pytest.mark.asyncio
async def test_bulk_endpoints_reject_an_empty_id_list(async_client, override_services):
    """An empty bulk request is a caller mistake, not a no-op."""
    response = await async_client.post(
        f"/api/v1/knowledge/chunks/bulk-toggle?bot_id={BOT_ID}",
        json={"chunk_ids": [], "enabled": True},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_source_vector_deletion_endpoint_reports_the_count(async_client, override_services):
    _, store = override_services
    store.pool.conn.status = "DELETE 4"

    response = await async_client.delete(
        f"/api/v1/knowledge/sources/src_1?bot_id={BOT_ID}"
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "success": True,
        "bot_id": BOT_ID,
        "source_id": "src_1",
        "chunks_deleted": 4,
    }


@pytest.mark.asyncio
async def test_ingest_document_returns_per_chunk_detail(async_client):
    """The server has no other way to learn these ids — it owns the source row, not the vectors."""
    chunk_id = str(uuid.uuid4())

    class FakeKnowledge:
        async def ingest_document(self, **kwargs) -> Dict[str, Any]:
            assert kwargs["source_id"] == "src_1"
            assert kwargs["topic"] == "Handbook", "filename stem should be the fallback topic only"
            return {
                "success": True,
                "pages_extracted": 2,
                "chunks_created": 1,
                "chunks": [
                    {
                        "id": chunk_id,
                        "chunk_index": 0,
                        "content": "hello world",
                        "page_number": 1,
                        "topic": "Handbook",
                    }
                ],
                "embedding_model": "stub-model",
                "embedding_dimension": 4,
            }

    app.dependency_overrides[get_knowledge_service] = lambda: FakeKnowledge()
    try:
        response = await async_client.post(
            "/api/v1/knowledge/ingest-document",
            files={"file": ("handbook.pdf", b"%PDF-1.4 fake", "application/pdf")},
            data={"bot_id": BOT_ID, "source_id": "src_1", "topic": "Handbook"},
        )
    finally:
        app.dependency_overrides.pop(get_knowledge_service, None)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["pages_extracted"] == 2
    assert body["embedding_dimension"] == 4
    assert body["chunks"] == [
        {
            "id": chunk_id,
            "chunk_index": 0,
            "content": "hello world",
            "page_number": 1,
            "topic": "Handbook",
        }
    ]


@pytest.mark.asyncio
async def test_ingest_document_requires_a_source_id(async_client, override_services):
    """Without it the vectors would be stored with no link back to the server's source row."""
    response = await async_client.post(
        "/api/v1/knowledge/ingest-document",
        files={"file": ("handbook.pdf", b"%PDF-1.4 fake", "application/pdf")},
        data={"bot_id": BOT_ID},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_ingest_document_rejects_an_empty_file(async_client, override_services):
    response = await async_client.post(
        "/api/v1/knowledge/ingest-document",
        files={"file": ("handbook.pdf", b"", "application/pdf")},
        data={"bot_id": BOT_ID, "source_id": "src_1"},
    )

    assert response.status_code == 400
    assert "empty" in response.json()["detail"].lower()


@pytest.mark.asyncio
async def test_ingest_document_maps_an_unsupported_type_to_400(async_client):
    """The extractor raises ValueError; the route must not turn that into a 500."""
    class FakeKnowledge:
        async def ingest_document(self, **kwargs):
            raise ValueError("Unsupported file type '.txt'.")

    app.dependency_overrides[get_knowledge_service] = lambda: FakeKnowledge()
    try:
        response = await async_client.post(
            "/api/v1/knowledge/ingest-document",
            files={"file": ("notes.txt", b"hello", "text/plain")},
            data={"bot_id": BOT_ID, "source_id": "src_1"},
        )
    finally:
        app.dependency_overrides.pop(get_knowledge_service, None)

    assert response.status_code == 400
    assert "Unsupported file type" in response.json()["detail"]


@pytest.mark.asyncio
async def test_ingest_document_maps_a_store_outage_to_503(async_client):
    """A disconnected vector store is an availability problem, not a bad upload."""
    class FakeKnowledge:
        async def ingest_document(self, **kwargs):
            raise RuntimeError("Cannot write chunks: vector store is not connected.")

    app.dependency_overrides[get_knowledge_service] = lambda: FakeKnowledge()
    try:
        response = await async_client.post(
            "/api/v1/knowledge/ingest-document",
            files={"file": ("handbook.pdf", b"%PDF-1.4 fake", "application/pdf")},
            data={"bot_id": BOT_ID, "source_id": "src_1"},
        )
    finally:
        app.dependency_overrides.pop(get_knowledge_service, None)

    assert response.status_code == 503
