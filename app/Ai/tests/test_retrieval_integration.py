"""Checkpoint 7 — retrieval integration.

The claim this module pins is narrow and structural: **there is exactly one read path
from a bot's knowledge to an answer**, and that path filters disabled chunks in SQL.

That matters because the plan asks for two separate confirmations — that disabled chunks
are excluded from *chat* retrieval, and not merely from the test-retrieval endpoint. Those
would be two independent facts if chat and the test panel each queried pgvector. They are
one fact here, because both reach `VectorStoreService.search()`: the test panel through
`POST /api/v1/rag/search` -> `RAGService.search`, and chat through `ChatService.process_chat`
-> the same `RAGService.search`. The filter lives at the bottom of that single funnel
(`AND enabled = true`), which `test_knowledge_management.py` asserts against the real SQL.

So what is asserted here is the shape of the funnel, in the two places it could be broken
without anyone noticing:

  1. `RAGService` must not post-filter in Python. Dropping results in Python would be
     invisible in a unit test and catastrophic in production: `LIMIT top_k` is applied
     *before* the filter would run, so disabled chunks would consume the result slots and
     a bot with three disabled chunks and `top_k=3` would answer from nothing. The store
     returns them filtered, or they are returned at all.
  2. `ChatService` must take its context from `rag.search()` and from nothing else. If it
     ever grew its own vector-store reference, the filter would become optional and this
     suite would still pass — so the absence of that reference is asserted directly.

**Not covered here, and deliberately so.** The seven end-to-end steps in the plan
(upload -> chat -> disable -> chat -> edit -> chat -> delete) need a running stack:
PostgreSQL with pgvector, both services up, and a configured LLM provider. None of those
are present in this environment, and a test that stubbed all three would be asserting
that the stubs agree with each other. What is provable without them is that the steps
*cannot diverge* — one funnel, one filter, no bypass — which is the property the seven
steps are a manual confirmation of.
"""

from typing import Any, Dict, Optional

import pytest

from app.core.constants import FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE
from app.services.chat_service import get_chat_service
from app.services.rag_service import get_rag_service

BOT_ID = "bot_retrieval_integration"
QUERY = "How long do refunds take?"


class RecordingVectorStore:
    """Stands in for pgvector and records how it was called.

    `rows` is what the store returns. Because the real store has already applied
    `enabled = true` by the time it returns, a row appearing here is by definition one the
    caller is allowed to see — which is what makes "no post-filter" testable from above.
    """

    def __init__(self, rows: Optional[list] = None) -> None:
        self.rows = rows if rows is not None else []
        self.calls: list[Dict[str, Any]] = []

    async def search(
        self,
        query_embedding,
        bot_id: str,
        top_k: int = 5,
        topic_filter: Optional[str] = None,
    ) -> list:
        self.calls.append(
            {
                "query_embedding": query_embedding,
                "bot_id": bot_id,
                "top_k": top_k,
                "topic_filter": topic_filter,
            }
        )
        return self.rows


class RecordingEmbedder:
    """Records the text it was asked to embed, so the query's journey is visible."""

    def __init__(self) -> None:
        self.texts: list[str] = []

    async def embed_text(self, text: str) -> list:
        self.texts.append(text)
        return [0.1, 0.2, 0.3, 0.4]


@pytest.fixture
def rag():
    """The process-wide RAG singleton, with both of its collaborators replaced.

    Patched onto the instance rather than the class: `get_rag_service()` hands every caller
    the same object, and a class-level patch would leave that object holding the originals.
    """
    service = get_rag_service()
    store = RecordingVectorStore()
    embedder = RecordingEmbedder()
    original_store, original_embedder = service.vector_store, service.embedder
    service.vector_store, service.embedder = store, embedder
    yield service, store, embedder
    service.vector_store, service.embedder = original_store, original_embedder


# ---------------------------------------------------------------------------------------
# The retrieval service forwards; it does not decide
# ---------------------------------------------------------------------------------------


class TestRAGServiceIsAPassThrough:
    @pytest.mark.asyncio
    async def test_the_query_is_embedded_and_the_embedding_is_what_reaches_the_store(self, rag):
        service, store, embedder = rag
        store.rows = []

        await service.search(QUERY, BOT_ID, top_k=3)

        assert embedder.texts == [QUERY]
        # The *embedded* vector, not the raw query: a store called with the string would be
        # doing its own embedding, and the two would then be able to disagree.
        assert store.calls[0]["query_embedding"] == [0.1, 0.2, 0.3, 0.4]
        assert store.calls[0]["bot_id"] == BOT_ID
        assert store.calls[0]["top_k"] == 3

    @pytest.mark.asyncio
    async def test_results_are_returned_unfiltered_even_below_the_confidence_threshold(self, rag):
        """A low score changes `is_confident`; it must not remove the result.

        The threshold answers "should the bot answer from this?", which the caller decides.
        Dropping the row here would answer it a second time, silently, and the test panel
        would then show fewer chunks than the store actually matched — while the reply that
        used them had already been generated from a context the panel never displayed.
        """
        service, store, _ = rag
        store.rows = [{"id": "chunk_low", "content": "Barely related.", "score": 0.02}]

        result = await service.search(QUERY, BOT_ID, top_k=3)

        assert [row["id"] for row in result["results"]] == ["chunk_low"]
        assert result["top_score"] == 0.02
        assert result["is_confident"] is False

    @pytest.mark.asyncio
    async def test_the_topic_filter_is_passed_through_rather_than_applied_here(self, rag):
        """The topic filter narrows the SQL query; it is not a second filter on the rows.

        Applying it in Python would fetch every topic's chunks under `LIMIT top_k` and then
        discard most of them — the same slot-consumption failure the enabled filter avoids.
        """
        service, store, _ = rag
        store.rows = []

        await service.search(QUERY, BOT_ID, top_k=5, topic_filter="REFUND")

        assert store.calls[0]["topic_filter"] == "REFUND"
        assert store.calls[0]["top_k"] == 5


# ---------------------------------------------------------------------------------------
# Chat takes its context from that path, and from nowhere else
# ---------------------------------------------------------------------------------------


class StubClassifier:
    def classify(self, text: str) -> Dict[str, Any]:
        return {"intent": "faq_match", "confidence": 0.95, "is_confident": True}


class StubLLM:
    """Records the prompts it was handed and returns a marker, so the context is visible."""

    def __init__(self) -> None:
        self.calls: list[Dict[str, Any]] = []

    async def generate(
        self,
        prompt: str,
        model_id: Optional[str] = None,
        system_message: Optional[str] = None,
        temperature: float = 0.0,
        model=None,
    ) -> str:
        self.calls.append({"prompt": prompt, "system_message": system_message})
        return "Stub answer."


@pytest.fixture
def chat():
    """The chat singleton with its classifier and model replaced.

    Only those two: `rag` is left as the real service, wired to a recording store, so the
    test exercises the actual seam between chat and retrieval rather than a stub of it.
    """
    service = get_chat_service()
    llm = StubLLM()
    original_classifier, original_llm, original_rag = service.classifier, service.llm, service.rag
    original_store, original_embedder = service.rag.vector_store, service.rag.embedder

    store = RecordingVectorStore()
    service.classifier = StubClassifier()
    service.llm = llm
    service.rag.vector_store = store
    service.rag.embedder = RecordingEmbedder()

    yield service, store, llm

    service.classifier, service.llm, service.rag = original_classifier, original_llm, original_rag
    service.rag.vector_store, service.rag.embedder = original_store, original_embedder


class TestChatRetrievesThroughTheSameFunnel:
    @pytest.mark.asyncio
    async def test_the_chunks_the_store_returns_are_the_ones_the_model_is_given(self, chat):
        """End to end across the seam: store row -> RAG -> prompt.

        The distinctive string is the whole test. If chat assembled its context from
        anywhere but `rag.search()`, the marker would not appear in the prompt — and the
        enabled filter that guards the store would be guarding nothing that matters.
        """
        service, store, llm = chat
        store.rows = [
            {"id": "chunk_1", "topic": "REFUND", "content": "Refunds take five days.", "score": 0.9}
        ]

        result = await service.process_chat(bot_id=BOT_ID, message=QUERY)

        assert store.calls[0]["bot_id"] == BOT_ID
        assert len(llm.calls) == 1
        assert "Refunds take five days." in llm.calls[0]["prompt"]
        assert result["retrieval"]["documents_found"] == 1
        assert result["fallback_required"] is False

    @pytest.mark.asyncio
    async def test_no_retrievable_chunks_means_no_generation_at_all(self, chat):
        """An empty retrieval is a fallback, and the model is never called.

        This is the direction that proves chat has no second source of context: if it did,
        an empty knowledge base would still produce a generation, and a bot whose every
        chunk had been disabled would answer from that other source as though nothing had
        changed. `documents_found: 0` is what the customer's debug view will show.
        """
        service, store, llm = chat
        store.rows = []

        result = await service.process_chat(bot_id=BOT_ID, message=QUERY)

        assert len(store.calls) == 1
        assert llm.calls == []
        assert result["fallback_required"] is True
        assert result["reason"] == FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE
        assert result["retrieval"]["documents_found"] == 0

    @pytest.mark.asyncio
    async def test_chat_holds_no_second_path_to_the_vector_store(self, chat):
        """The bypass that would quietly break the filter, asserted as an absence.

        `ChatService` may reach pgvector only through `self.rag`. A direct reference — a
        convenience added later, for a count or a lookup — would compile, pass every other
        test in this file, and make the SQL filter optional. This is deliberately a check
        on the object's own surface rather than on a call, because the risk is the
        reference existing at all, not any particular use of it.
        """
        service, _, _ = chat

        direct = [
            name
            for name in vars(service)
            if "vector" in name.lower() or "store" in name.lower()
        ]

        assert direct == [], (
            f"ChatService holds {direct}; retrieval must go through self.rag so the "
            "enabled filter cannot be bypassed."
        )
