"""Checkpoint 4 — the three strictness presets, and what "knowledge off" really means.

Two criteria are evidenced here, and they are evidenced differently on purpose.

*The presets* are tested through the documented behaviour table (plan §15.2), row by row, at
the **pipeline** level and at the **function** level. Both, because the table is a statement
about what an owner gets, while `_refusal_reason` is the one place the three conditions live —
a preset that works only because a caller happens to evaluate the conditions in a particular
order is a preset that breaks the next time something else calls that function.

*`knowledge.enabled = false`* is tested against the **real** `RAGService` with a spied
embedder, not against a stub that records "search was not called". The criterion is "performs
no embedding call (asserted, not assumed)", and a stub could satisfy it while the real service
embedded anyway. Here the real service is in place and the real embedder raises if touched, so
the assertion is about the pipeline's decision rather than about a test double's silence.

The `LOW_RETRIEVAL_CONFIDENCE` branch deserves a note: it existed in this service before
Checkpoint 4 and was unreachable, because nothing consulted `is_confident`. The first test
class below is therefore the first thing in the repository's history that executes it.
"""

from typing import Any, Dict, List, Optional

import pytest

from app.core.config import settings
from app.core.constants import (
    FALLBACK_REASON_LOW_RETRIEVAL_CONFIDENCE,
    FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE,
    INSUFFICIENT_INFORMATION_SIGNAL,
)
from app.prompts.support_prompt import get_support_system_prompt
from app.services.chat_service import (
    _confidence_gate_passed,
    _refusal_reason,
    get_chat_service,
)
from app.services.rag_service import RAGService

BOT_ID = "bot_strictness_1"
MESSAGE = "How long do refunds take?"
TOPIC = "REFUND"
CHUNK_CONTENT = "Refunds are processed within five business days."

#: The threshold the real service compares against, read from settings rather than written
#: as a literal so the "just below" and "just above" cases cannot drift from it.
THRESHOLD = settings.RETRIEVAL_CONFIDENCE_THRESHOLD


def config_for(strictness: Optional[str] = "BALANCED", *, enabled: bool = True) -> Dict[str, Any]:
    """A configuration as Node sends it: complete enough for `BotConfig` to accept."""
    knowledge: Dict[str, Any] = {"enabled": enabled}
    if strictness is not None:
        knowledge["strictness"] = strictness
    return {"knowledge": knowledge}


def chunk(chunk_id: str = "chunk_1", content: str = CHUNK_CONTENT) -> Dict[str, Any]:
    return {
        "id": chunk_id,
        "bot_id": BOT_ID,
        "topic": TOPIC,
        "content": content,
        "source_id": "src_1",
        "metadata": {"source_id": "src_1", "page_number": 2},
        "score": 0.91,
    }


class StubClassifier:
    def __init__(self, is_confident: bool = True, intent: str = "faq_match") -> None:
        self.is_confident = is_confident
        self.intent = intent

    def classify(self, text: str) -> Dict[str, Any]:
        return {"intent": self.intent, "confidence": 0.95, "is_confident": self.is_confident}


class StubRag:
    """A stand-in for the retrieval seam that reports a real score.

    `is_confident` is **computed** from `top_score` against the service's own threshold rather
    than passed in, so the STRICT tests exercise the comparison the plan describes instead of a
    boolean the test chose. A test that set both independently could pass while the threshold
    was applied nowhere.
    """

    def __init__(
        self, top_score: float = 0.91, results: Optional[List[Dict[str, Any]]] = None
    ) -> None:
        if results is None:
            results = [chunk()] if top_score > 0.0 else []
        self.results = results
        self.top_score = top_score
        self.calls: List[Dict[str, Any]] = []

    async def search(self, query, bot_id, top_k=3, topic_filter=None) -> Dict[str, Any]:
        self.calls.append({"query": query, "top_k": top_k, "topic_filter": topic_filter})
        return {
            "query": query,
            "results": self.results,
            "top_score": self.top_score,
            "is_confident": self.top_score >= THRESHOLD,
            "threshold": THRESHOLD,
            "used_topic_filter": topic_filter is not None,
        }


class StubLLM:
    """Accepts the configured argument list, including `params`."""

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
        self.calls.append(
            {
                "prompt": prompt,
                "system_message": system_message,
                "temperature": temperature,
                "model": model,
                "params": params,
            }
        )
        return self.reply


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


# --------------------------------------------------------------------------------------
# The table, as a function
# --------------------------------------------------------------------------------------


class TestTheThreePresetsAsDecisions:
    """`_refusal_reason` evaluated directly, one row of plan §15.2 per assertion."""

    def confident(self) -> Dict[str, Any]:
        return {"results": [chunk()], "is_confident": True, "top_score": 0.91}

    def unconfident(self) -> Dict[str, Any]:
        return {"results": [chunk()], "is_confident": False, "top_score": 0.10}

    def empty(self) -> Dict[str, Any]:
        return {"results": [], "is_confident": False, "top_score": 0.0}

    def test_strict_generates_from_confident_results(self):
        assert _refusal_reason("STRICT", self.confident()) is None

    def test_strict_refuses_low_confidence(self):
        """The branch that was dead before this checkpoint."""
        assert (
            _refusal_reason("STRICT", self.unconfident())
            == FALLBACK_REASON_LOW_RETRIEVAL_CONFIDENCE
        )

    def test_strict_refuses_empty_results(self):
        assert _refusal_reason("STRICT", self.empty()) == FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE

    def test_balanced_generates_from_confident_results(self):
        assert _refusal_reason("BALANCED", self.confident()) is None

    def test_balanced_ignores_low_confidence(self):
        """BALANCED has no score gate — this is exactly the pre-feature behaviour."""
        assert _refusal_reason("BALANCED", self.unconfident()) is None

    def test_balanced_refuses_empty_results(self):
        assert _refusal_reason("BALANCED", self.empty()) == FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE

    def test_flexible_generates_from_confident_results(self):
        assert _refusal_reason("FLEXIBLE", self.confident()) is None

    def test_flexible_ignores_low_confidence(self):
        assert _refusal_reason("FLEXIBLE", self.unconfident()) is None

    def test_flexible_generates_with_no_results_at_all(self):
        """The only preset for which an empty retrieval is not a refusal (§15.2)."""
        assert _refusal_reason("FLEXIBLE", self.empty()) is None

    def test_no_configuration_behaves_as_balanced(self):
        """`None` falls through both special cases by construction, not by a branch."""
        assert _refusal_reason(None, self.confident()) is None
        assert _refusal_reason(None, self.unconfident()) is None
        assert _refusal_reason(None, self.empty()) == FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE

    def test_the_gate_flag_agrees_with_the_refusal_for_every_preset_and_result(self):
        """One gate, one evaluation — the flag is derived, so the two cannot disagree."""
        for strictness in ("STRICT", "BALANCED", "FLEXIBLE", None):
            for rag in (self.confident(), self.unconfident(), self.empty()):
                refused = _refusal_reason(strictness, rag) is not None
                assert _confidence_gate_passed(strictness, rag) is (not refused)

    def test_a_turn_refused_for_having_no_results_reports_the_gate_as_not_passed(self):
        """The flag reports the whole gate, not the score comparison alone."""
        assert _confidence_gate_passed("BALANCED", self.empty()) is False


# --------------------------------------------------------------------------------------
# The table, through the pipeline
# --------------------------------------------------------------------------------------


class TestThePresetsThroughThePipeline:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "strictness, top_score, should_refuse, reason",
        [
            ("STRICT", 0.91, False, None),
            ("STRICT", 0.10, True, FALLBACK_REASON_LOW_RETRIEVAL_CONFIDENCE),
            ("BALANCED", 0.91, False, None),
            ("BALANCED", 0.10, False, None),
            ("FLEXIBLE", 0.91, False, None),
            ("FLEXIBLE", 0.10, False, None),
        ],
    )
    async def test_each_preset_produces_its_documented_behaviour(
        self, async_client, pipeline, strictness, top_score, should_refuse, reason
    ):
        service, llm, _ = pipeline
        service.rag = StubRag(top_score=top_score)

        response = await post_chat(async_client, config=config_for(strictness))
        body = response.json()

        assert body["fallback_required"] is should_refuse
        assert body["reason"] == reason
        assert len(llm.calls) == (0 if should_refuse else 1)

    @pytest.mark.asyncio
    async def test_strict_refuses_before_spending_a_provider_call(self, async_client, pipeline):
        """A refusal is a decision, not a failed generation."""
        service, llm, _ = pipeline
        service.rag = StubRag(top_score=0.10)

        await post_chat(async_client, config=config_for("STRICT"))

        assert llm.calls == []

    @pytest.mark.asyncio
    async def test_strict_refuses_a_retrieval_that_returned_nothing(self, async_client, pipeline):
        service, llm, _ = pipeline
        service.rag = StubRag(top_score=0.0, results=[])

        body = (await post_chat(async_client, config=config_for("STRICT"))).json()

        assert body["reason"] == FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE
        assert llm.calls == []

    @pytest.mark.asyncio
    async def test_flexible_still_generates_when_nothing_was_retrieved(self, async_client, pipeline):
        """The prompt is the only difference; the model is called with an empty context."""
        service, llm, _ = pipeline
        service.rag = StubRag(top_score=0.0, results=[])

        body = (await post_chat(async_client, config=config_for("FLEXIBLE"))).json()

        assert body["fallback_required"] is False
        assert body["response"] == "Stub answer."
        assert len(llm.calls) == 1
        assert body["retrieval"]["documents_found"] == 0

    @pytest.mark.asyncio
    async def test_the_low_confidence_refusal_reaches_the_client_with_its_own_copy(
        self, async_client, pipeline
    ):
        service, _, _ = pipeline
        service.rag = StubRag(top_score=0.10)

        body = (await post_chat(async_client, config=config_for("STRICT"))).json()

        # A refusal carries the fallback service's copy for the reason, not the model's words.
        assert body["response"] != "Stub answer."
        assert body["response"]
        assert body["sources"] is None

    @pytest.mark.asyncio
    async def test_the_refusal_is_logged_with_the_threshold_it_was_measured_against(
        self, async_client, pipeline, caplog
    ):
        """A refusal log that omits the bar is a boolean with no way to read it."""
        service, _, _ = pipeline
        service.rag = StubRag(top_score=0.10)

        with caplog.at_level("INFO", logger="assistiq_ai"):
            await post_chat(async_client, config=config_for("STRICT"))

        records = [r for r in caplog.records if getattr(r, "operation", None) == "knowledge_gate"]
        assert len(records) == 1
        assert records[0].reason == FALLBACK_REASON_LOW_RETRIEVAL_CONFIDENCE
        assert records[0].strictness == "STRICT"
        assert records[0].threshold == THRESHOLD
        assert records[0].top_score == 0.10

    @pytest.mark.asyncio
    async def test_a_successful_turn_is_not_logged_as_a_refusal(self, async_client, pipeline, caplog):
        with caplog.at_level("INFO", logger="assistiq_ai"):
            await post_chat(async_client, config=config_for("BALANCED"))

        assert not [
            r for r in caplog.records if getattr(r, "operation", None) == "knowledge_gate"
        ]

    @pytest.mark.asyncio
    async def test_the_configured_top_k_still_reaches_retrieval(self, async_client, pipeline):
        """`top_k` is the one advanced retrieval control the plan keeps owner-facing."""
        _, _, rag = pipeline

        await post_chat(
            async_client, config={"knowledge": {"strictness": "BALANCED", "top_k": 7}}
        )

        assert rag.calls[0]["top_k"] == 7

    @pytest.mark.asyncio
    async def test_prose_containing_the_sentinel_is_still_treated_as_a_refusal(
        self, async_client, pipeline
    ):
        """The regression guard the plan's risk table asks for.

        Detection is a substring match on the whole reply, so prose that happens to contain
        the token is a refusal. That bluntness is pre-feature behaviour, and a configured bot
        on the knowledge path must not have "improved" it — a smarter match here would be an
        unannounced behaviour change.
        """
        service, llm, _ = pipeline
        llm.reply = f"The answer may be {INSUFFICIENT_INFORMATION_SIGNAL} or something else."

        body = (await post_chat(async_client, config=config_for("BALANCED"))).json()

        assert body["reason"] == "LLM_INSUFFICIENT_INFORMATION"


# --------------------------------------------------------------------------------------
# knowledge.enabled = false
# --------------------------------------------------------------------------------------


class TestKnowledgeDisabledPerformsNoEmbeddingCall:
    """The criterion, asserted against the real retrieval service rather than a stub."""

    @pytest.mark.asyncio
    async def test_the_real_embedder_is_never_reached(self, async_client, pipeline, monkeypatch):
        """The pipeline's own decision, with the real `RAGService` in place.

        The stub in `pipeline` is replaced by a real `RAGService`, whose embedder and vector
        store are wired to fail loudly if touched. A stub that merely recorded "search was not
        called" would satisfy the criterion without proving anything about the code that would
        have run.
        """
        service, llm, _ = pipeline
        real_rag = RAGService()
        monkeypatch.setattr(service, "rag", real_rag)

        embedding_calls: List[str] = []

        async def fail_if_embedded(text: str) -> List[float]:
            embedding_calls.append(text)
            raise AssertionError("the pipeline embedded the query with knowledge disabled")

        async def fail_if_searched(**kwargs):
            raise AssertionError("the pipeline queried the vector store with knowledge disabled")

        monkeypatch.setattr(real_rag.embedder, "embed_text", fail_if_embedded)
        monkeypatch.setattr(real_rag.vector_store, "search", fail_if_searched)

        body = (await post_chat(async_client, config=config_for(enabled=False))).json()

        assert embedding_calls == []
        assert body["fallback_required"] is False
        assert len(llm.calls) == 1

    @pytest.mark.asyncio
    async def test_the_response_reports_no_retrieval_rather_than_a_search_that_failed(
        self, async_client, pipeline
    ):
        body = (await post_chat(async_client, config=config_for(enabled=False))).json()

        assert body["retrieval"]["documents_found"] == 0
        assert body["retrieval"]["top_score"] == 0.0
        assert body["retrieval"]["used_topic_filter"] is False

    @pytest.mark.asyncio
    async def test_it_answers_rather_than_refusing_on_an_empty_retrieval(
        self, async_client, pipeline
    ):
        """A bot with no knowledge base that refused to answer would be useless (§15.1)."""
        _, llm, _ = pipeline

        body = (await post_chat(async_client, config=config_for(enabled=False))).json()

        assert body["fallback_required"] is False
        assert llm.calls[0]["prompt"]  # the model was asked, with an empty context block

    @pytest.mark.asyncio
    async def test_the_sentinel_in_the_reply_is_not_a_fallback_in_this_mode(
        self, async_client, pipeline
    ):
        """The requirement is dropped with the knowledge base (§15.1).

        The prompt in this mode teaches no sentinel and forbids internal code words, so a
        reply containing one is a model that disobeyed — and turning that into a refusal would
        make a general-knowledge bot refuse for a reason its owner switched off.
        """
        service, llm, _ = pipeline
        llm.reply = f"I think so. {INSUFFICIENT_INFORMATION_SIGNAL}"

        body = (await post_chat(async_client, config=config_for(enabled=False))).json()

        assert body["fallback_required"] is False
        assert body["reason"] is None
        assert body["response"] == llm.reply

    @pytest.mark.asyncio
    async def test_the_system_prompt_switches_to_the_no_knowledge_mode(self, async_client, pipeline):
        _, llm, _ = pipeline

        await post_chat(async_client, config=config_for(enabled=False))

        system_prompt = llm.calls[0]["system_message"]
        assert system_prompt != get_support_system_prompt()
        assert "no knowledge base" in system_prompt
        # And the sentinel is not taught in this mode, at either restatement site.
        assert INSUFFICIENT_INFORMATION_SIGNAL not in system_prompt

    @pytest.mark.asyncio
    async def test_classification_still_runs_and_still_reports_an_intent(
        self, async_client, pipeline
    ):
        """Classification is local and free, and `intent` is part of the response contract."""
        body = (await post_chat(async_client, config=config_for(enabled=False))).json()

        assert body["intent"] == {"predicted": "faq_match", "confidence": 0.95}

    @pytest.mark.asyncio
    async def test_strictness_is_recorded_even_though_no_gate_was_evaluated(
        self, async_client, pipeline
    ):
        """The value still travelled with the request, so the log should still name it."""
        service, _, _ = pipeline
        result = await service.process_chat(
            bot_id=BOT_ID, message=MESSAGE, config=_config_model(enabled=False, strictness="STRICT")
        )

        assert result["retrieval"]["strictness_applied"] == "STRICT"
        assert result["retrieval"]["confidence_gate_passed"] is None


def _config_model(*, enabled: bool, strictness: str):
    """The schema model, for the tests that call the service directly."""
    from app.schemas.chat import BotConfig

    return BotConfig.model_validate(config_for(strictness, enabled=enabled))
