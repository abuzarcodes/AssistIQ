"""Checkpoint 4 — `ChatResponse.sources`: when it exists, and what it may contain.

The plan states the rule twice and in two directions (plan §15.3 and this checkpoint's
criteria), so this module tests it twice too:

*The gate* — `sources` is populated only when `knowledge.show_sources` is on, and only for a
turn that produced an answer. Every other path leaves it `null`, including the one that looks
most tempting to fill: a refusal, where the passages that failed to answer the question are
right there. Listing them would tell the customer their question was searched and found
wanting, which is worse than saying nothing.

*The contents* — identifiers only. `SourceRef` has four fields and the assertions below name
the exact key set of the serialised object, so a `score` (or a `content`, or anything else)
cannot appear in a customer-facing payload without failing here. That is the Tier 3 boundary
the plan draws: *which document* an answer came from is a feature, *how well it scored* is the
deferred retrieval-diagnostics surface, and the two differ by exactly one field.

The risk the plan names — `debug_info["retrieval_results"]` holding full chunk text on the
production return value — is covered at the end. It is a pre-existing arrangement the route
strips; turning sources on must not change that, so it is asserted rather than assumed.
"""

from typing import Any, Dict, List, Optional

import pytest

from app.core.constants import FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION
from app.providers import ProviderError, ProviderErrorKind
from app.services.chat_service import _blank_to_none, _sources_for, get_chat_service
from app.schemas.chat import SourceRef

BOT_ID = "bot_sources_1"
MESSAGE = "How long do refunds take?"
TOPIC = "REFUND"
CHUNK_CONTENT = "Refunds are processed within five business days."

#: The exact key set a source may serialise to. Not "at least these" — exactly these. A new
#: key is how a score would arrive.
SOURCE_KEYS = {"chunk_id", "source_id", "topic", "page_number"}


def document_chunk(
    chunk_id: str = "chunk_1",
    source_id: Optional[str] = "src_1",
    page_number: Optional[int] = 2,
) -> Dict[str, Any]:
    return {
        "id": chunk_id,
        "bot_id": BOT_ID,
        "topic": TOPIC,
        "content": CHUNK_CONTENT,
        "source_id": source_id,
        "metadata": {"source_id": source_id, "page_number": page_number},
        "score": 0.91,
    }


def faq_chunk(entry_id: str = "faq_1", chunk_id: str = "chunk_faq_1") -> Dict[str, Any]:
    """An FAQ chunk as `chunking_service.create_faq_chunks` builds it.

    No `source_id` (the column takes the ingestion path's `""`), no `page_number` key at all,
    and a `source_id` in metadata that is the *entry* id rather than a document's.
    """
    return {
        "id": chunk_id,
        "bot_id": BOT_ID,
        "topic": "GENERAL_SUPPORT",
        "content": "Yes, you can return an item within 30 days.",
        "source_id": "",
        "metadata": {"source_id": entry_id, "topic": "GENERAL_SUPPORT", "chunk_index": 0},
        "score": 0.83,
    }


class StubClassifier:
    def __init__(self, is_confident: bool = True, intent: str = "faq_match") -> None:
        self.is_confident = is_confident
        self.intent = intent

    def classify(self, text: str) -> Dict[str, Any]:
        return {"intent": self.intent, "confidence": 0.95, "is_confident": self.is_confident}


class StubRag:
    def __init__(self, results: Optional[List[Dict[str, Any]]] = None, top_score: float = 0.91) -> None:
        self.results = [document_chunk()] if results is None else results
        self.top_score = top_score

    async def search(self, query, bot_id, top_k=3, topic_filter=None) -> Dict[str, Any]:
        return {
            "query": query,
            "results": self.results,
            "top_score": self.top_score,
            "is_confident": self.top_score >= 0.65,
            "threshold": 0.65,
            "used_topic_filter": topic_filter is not None,
        }


class StubLLM:
    def __init__(self, reply: str = "Stub answer.") -> None:
        self.reply = reply
        self.calls: List[Dict[str, Any]] = []

    async def generate(
        self,
        prompt: str,
        system_message: Optional[str] = None,
        temperature: float = 0.0,
        model: Optional[Any] = None,
        params: Optional[Any] = None,
    ) -> str:
        self.calls.append({"prompt": prompt, "system_message": system_message})
        return self.reply


class FailingLLM:
    """Every call raises, so the pipeline takes its provider-failure path."""

    def __init__(self, kind: ProviderErrorKind = ProviderErrorKind.UPSTREAM) -> None:
        self.kind = kind
        self.calls = 0

    async def generate(self, prompt, system_message=None, temperature=0.0, model=None, params=None):
        self.calls += 1
        raise ProviderError(self.kind, provider="openrouter", model_id="openai/gpt-4o-mini")


@pytest.fixture
def pipeline(monkeypatch):
    service = get_chat_service()
    llm = StubLLM()
    rag = StubRag()
    monkeypatch.setattr(service, "classifier", StubClassifier())
    monkeypatch.setattr(service, "llm", llm)
    monkeypatch.setattr(service, "rag", rag)
    return service, llm, rag


def post_chat(client, **overrides):
    payload: Dict[str, Any] = {"bot_id": BOT_ID, "message": MESSAGE}
    payload.update(overrides)
    return client.post("/api/v1/chat", json=payload)


def showing(**knowledge) -> Dict[str, Any]:
    return {"knowledge": {"enabled": True, "strictness": "BALANCED", "show_sources": True, **knowledge}}


# --------------------------------------------------------------------------------------
# The gate
# --------------------------------------------------------------------------------------


class TestWhenSourcesArePresent:
    @pytest.mark.asyncio
    async def test_sources_are_populated_when_the_bot_asks_for_them(self, async_client, pipeline):
        body = (await post_chat(async_client, config=showing())).json()

        assert body["sources"] is not None
        assert len(body["sources"]) == 1
        assert body["sources"][0]["chunk_id"] == "chunk_1"

    @pytest.mark.asyncio
    async def test_sources_are_absent_when_the_bot_does_not_ask_for_them(
        self, async_client, pipeline
    ):
        body = (await post_chat(async_client, config=showing(show_sources=False))).json()

        assert body["sources"] is None

    @pytest.mark.asyncio
    async def test_sources_are_absent_when_the_field_is_simply_not_configured(
        self, async_client, pipeline
    ):
        """`show_sources` defaults to off, so a config that omits it says the same thing."""
        body = (await post_chat(async_client, config={"knowledge": {"enabled": True}})).json()

        assert body["sources"] is None

    @pytest.mark.asyncio
    async def test_sources_are_absent_for_a_request_with_no_configuration(
        self, async_client, pipeline
    ):
        body = (await post_chat(async_client)).json()

        assert body["sources"] is None

    @pytest.mark.asyncio
    async def test_a_sentinel_refusal_carries_no_sources(self, async_client, pipeline):
        """The tempting case, refused: the passages did not answer the question."""
        service, llm, _ = pipeline
        llm.reply = "I cannot answer that. INSUFFICIENT_INFORMATION"

        body = (await post_chat(async_client, config=showing())).json()

        assert body["reason"] == FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION
        assert body["sources"] is None

    @pytest.mark.asyncio
    async def test_an_empty_retrieval_refusal_carries_no_sources(self, async_client, pipeline):
        service, _, _ = pipeline
        service.rag = StubRag(results=[], top_score=0.0)

        body = (await post_chat(async_client, config=showing())).json()

        assert body["fallback_required"] is True
        assert body["sources"] is None

    @pytest.mark.asyncio
    async def test_a_provider_failure_carries_no_sources(self, async_client, pipeline):
        """Nothing generated, so there is no answer for the chunks to have grounded."""
        service, _, _ = pipeline
        service.llm = FailingLLM()

        body = (await post_chat(async_client, config=showing())).json()

        assert body["fallback_required"] is True
        assert body["sources"] is None

    @pytest.mark.asyncio
    async def test_a_flexible_bot_with_nothing_retrieved_reports_an_empty_list(
        self, async_client, pipeline
    ):
        """Asked for and generated, but nothing was retrieved: an empty list, not `null`.

        The distinction is the one that matters here — `null` means "you did not ask", `[]`
        means "you asked and there is nothing". Collapsing them would make a FLEXIBLE bot's
        sources impossible to reason about.
        """
        service, _, _ = pipeline
        service.rag = StubRag(results=[], top_score=0.0)

        body = (
            await post_chat(async_client, config=showing(strictness="FLEXIBLE"))
        ).json()

        assert body["fallback_required"] is False
        assert body["sources"] == []


# --------------------------------------------------------------------------------------
# The contents
# --------------------------------------------------------------------------------------


class TestWhatASourceMayContain:
    @pytest.mark.asyncio
    async def test_the_serialised_source_has_exactly_the_four_identifier_keys(
        self, async_client, pipeline
    ):
        """The score exclusion, asserted on the wire rather than on the object."""
        body = (await post_chat(async_client, config=showing())).json()

        assert set(body["sources"][0]) == SOURCE_KEYS

    @pytest.mark.asyncio
    async def test_no_score_appears_on_a_source(self, async_client, pipeline):
        """A similarity score must not ride along with a citation.

        Asserted per source rather than by searching the whole body for the score's digits,
        because `retrieval.top_score` is pre-existing response metadata that this checkpoint
        neither adds nor removes — the criterion is about `sources`, and a whole-body search
        would either fail on that legitimate field or have to be written loosely enough to
        miss a score genuinely attached to a citation.
        """
        body = (await post_chat(async_client, config=showing())).json()

        for source in body["sources"]:
            assert "score" not in source
            assert set(source) == SOURCE_KEYS

    @pytest.mark.asyncio
    async def test_no_chunk_text_reaches_the_body(self, async_client, pipeline):
        response = await post_chat(async_client, config=showing())

        assert CHUNK_CONTENT not in response.text

    @pytest.mark.asyncio
    async def test_the_identifiers_are_carried_through_unchanged(self, async_client, pipeline):
        service, _, _ = pipeline
        service.rag = StubRag(results=[document_chunk("chunk_9", "src_9", 7)])

        body = (await post_chat(async_client, config=showing())).json()

        assert body["sources"] == [
            {
                "chunk_id": "chunk_9",
                "source_id": "src_9",
                "topic": TOPIC,
                "page_number": 7,
            }
        ]

    @pytest.mark.asyncio
    async def test_an_faq_chunk_with_no_source_row_reports_none_not_an_empty_string(
        self, async_client, pipeline
    ):
        """Node turns `None` into the "FAQ entry" label; `""` would render as a blank name."""
        service, _, _ = pipeline
        service.rag = StubRag(results=[faq_chunk()], top_score=0.83)

        body = (await post_chat(async_client, config=showing())).json()

        assert body["sources"][0]["source_id"] is None
        assert body["sources"][0]["page_number"] is None
        assert body["sources"][0]["chunk_id"] == "chunk_faq_1"

    @pytest.mark.asyncio
    async def test_several_chunks_each_get_their_own_entry_in_retrieval_order(
        self, async_client, pipeline
    ):
        service, _, _ = pipeline
        service.rag = StubRag(
            results=[
                document_chunk("chunk_a", "src_a", 1),
                document_chunk("chunk_b", "src_b", 2),
                faq_chunk(),
            ]
        )

        body = (await post_chat(async_client, config=showing())).json()

        assert [s["chunk_id"] for s in body["sources"]] == ["chunk_a", "chunk_b", "chunk_faq_1"]

    @pytest.mark.asyncio
    async def test_two_chunks_from_the_same_document_are_both_listed(
        self, async_client, pipeline
    ):
        """Different pages are different citations; collapsing them would lose the page."""
        service, _, _ = pipeline
        service.rag = StubRag(
            results=[document_chunk("chunk_a", "src_a", 1), document_chunk("chunk_b", "src_a", 4)]
        )

        body = (await post_chat(async_client, config=showing())).json()

        assert [s["page_number"] for s in body["sources"]] == [1, 4]


class TestTheSourceBuilderDirectly:
    """`_sources_for` against chunk dicts the retrieval seam would never produce."""

    def test_blank_source_ids_normalise_to_none(self):
        assert _blank_to_none("") is None
        assert _blank_to_none("   ") is None
        assert _blank_to_none(None) is None
        assert _blank_to_none(" src_1 ") == "src_1"

    def test_a_chunk_with_no_metadata_still_yields_a_source(self):
        sources = _sources_for({"results": [{"id": "c1", "topic": None}]})

        assert sources == [SourceRef(chunk_id="c1", source_id=None, topic=None, page_number=None)]

    def test_missing_results_yield_no_sources(self):
        assert _sources_for({"results": []}) == []


# --------------------------------------------------------------------------------------
# The debug block
# --------------------------------------------------------------------------------------


class TestTheDebugBlockStaysServerSide:
    @pytest.mark.asyncio
    async def test_the_full_chunk_text_and_prompts_do_not_reach_the_client(
        self, async_client, pipeline
    ):
        """Turning sources on must not turn retrieval content on.

        `debug_info["retrieval_results"]` holds the full chunk text and is on the pipeline's
        return value; the route maps fields explicitly and strips it. With `show_sources` on,
        that stripping is the only thing standing between the customer and the knowledge base,
        so it is asserted here rather than inferred from the route's shape.
        """
        response = await post_chat(async_client, config=showing())

        assert CHUNK_CONTENT not in response.text
        assert "debug" not in response.json()
        assert "retrieval_results" not in response.text

    @pytest.mark.asyncio
    async def test_the_pipeline_result_does_carry_it_for_diagnosis(self, async_client, pipeline):
        """The other half: the block exists, which is what makes a failure diagnosable."""
        service, _, _ = pipeline
        from app.schemas.chat import BotConfig

        result = await service.process_chat(
            bot_id=BOT_ID, message=MESSAGE, config=BotConfig.model_validate(showing())
        )

        assert result["debug"]["retrieval_results"][0]["content"] == CHUNK_CONTENT
        assert result["sources"] is not None
