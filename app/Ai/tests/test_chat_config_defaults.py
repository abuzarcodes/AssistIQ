"""The N4 regression net: a request with **no configuration** behaves exactly as before.

This module is the evidence for the plan's load-bearing backward-compatibility claim —
"with `config=None`, `process_chat` must produce byte-identical output to today" — and it is
written to be *falsifiable*. Two choices make it so:

* The LLM stand-in accepts only the pre-feature argument list. It has no `params` parameter,
  so if the pipeline ever starts offering one on the unconfigured path this module fails with
  a `TypeError` rather than quietly passing a `None`. That is a stronger statement than
  comparing outputs: it pins the *call*, not just the answer.
* The golden values are literals of the pre-feature behaviour, each annotated with the line
  it came from. Checkpoint 0 left no captured-artefact file in this repository, so the golden
  is the code that shipped rather than a recorded run of it.

The additive differences, stated openly: `ChatResponse` gained `sources` in Checkpoint 3 and
`model_used` / `failover_used` / `human_requested` in Checkpoint 4, so every response body —
this one included — carries them at their defaults. That is the field set the plan mandates,
it is additive, and Node ignores all four on this path. Everything else is compared exactly,
and the key set is asserted explicitly so a *further* new key cannot appear unnoticed.

`model_used` being `None` here is not an omission: with no catalog model named, there is no
model to report, and this service must not report its own `LLM_PROVIDER` as though it were
the bot's assignment. `human_requested` is `False` by construction rather than by detection —
a caller that sends no configuration has no `humanRequestBehavior` for a detection to serve.
"""

from typing import Any, Dict, List, Optional

import pytest

from app.core.constants import (
    FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION,
    FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE,
    INSUFFICIENT_INFORMATION_SIGNAL,
)
from app.prompts.support_prompt import build_user_prompt, get_support_system_prompt
from app.services.chat_service import get_chat_service

BOT_ID = "bot_legacy_1"
MESSAGE = "How long do refunds take?"
TOPIC = "REFUND"
CHUNK_CONTENT = "Refunds are processed within five business days."

#: The context string the pipeline has always assembled: topic in brackets, chunks separated
#: by a blank line (`chat_service.py`, step 4, before this checkpoint).
GOLDEN_CONTEXT = f"[{TOPIC}] {CHUNK_CONTENT}"

#: The response body a request with no configuration produced before this feature, plus the
#: fields the configuration checkpoints add. Every added value is its default.
GOLDEN_BODY = {
    "status": "success",
    "response": "Stub answer.",
    "fallback_required": False,
    "reason": None,
    "intent": {"predicted": "faq_match", "confidence": 0.95},
    "retrieval": {"used_topic_filter": True, "top_score": 0.91, "documents_found": 1},
    "sources": None,
    "model_used": None,
    "failover_used": False,
    "human_requested": False,
}


class RecordingLLM:
    """A stand-in for `LLMService` that pins the pre-feature argument list.

    **No `params` parameter, deliberately.** The pipeline must not offer one on a request
    that carries no configuration, and the surest way to assert "must not" is to make it
    impossible for that call to succeed silently.
    """

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.reply = "Stub answer."

    async def generate(
        self,
        prompt: str,
        system_message: Optional[str] = None,
        temperature: float = 0.0,
        model: Optional[Any] = None,
    ) -> str:
        self.calls.append(
            {
                "prompt": prompt,
                "system_message": system_message,
                "temperature": temperature,
                "model": model,
            }
        )
        return self.reply


class RecordingClassifier:
    def __init__(self, is_confident: bool = True, intent: str = "faq_match") -> None:
        self.is_confident = is_confident
        self.intent = intent

    def classify(self, text: str) -> Dict[str, Any]:
        return {"intent": self.intent, "confidence": 0.95, "is_confident": self.is_confident}


class RecordingRag:
    """The retrieval seam, recording the depth it was asked for.

    `top_k` is recorded rather than ignored because it is the one pipeline input this
    checkpoint could have changed by accident: it used to be the literal `3` and is now read
    from the configuration. With no configuration it must still be `3`.
    """

    def __init__(self, results: Optional[List[Dict[str, Any]]] = None) -> None:
        self.results = (
            results
            if results is not None
            else [
                {
                    "id": "chunk_1",
                    "bot_id": BOT_ID,
                    "topic": TOPIC,
                    "content": CHUNK_CONTENT,
                    "score": 0.91,
                }
            ]
        )
        self.top_scores: List[int] = []
        self.topic_filters: List[Optional[str]] = []

    async def search(self, query, bot_id, top_k=3, topic_filter=None) -> Dict[str, Any]:
        self.top_scores.append(top_k)
        self.topic_filters.append(topic_filter)
        top_score = self.results[0]["score"] if self.results else 0.0
        return {
            "query": query,
            "results": self.results,
            "top_score": top_score,
            "is_confident": top_score >= 0.65,
            "used_topic_filter": topic_filter is not None,
        }


@pytest.fixture
def pipeline(monkeypatch):
    """The chat singleton with all three seams replaced.

    `monkeypatch.setattr` on the instance attributes, not the class: `get_chat_service` hands
    the route a process-wide instance, and patching the class would leave that instance
    holding the originals.
    """
    service = get_chat_service()
    llm = RecordingLLM()
    rag = RecordingRag()
    monkeypatch.setattr(service, "classifier", RecordingClassifier())
    monkeypatch.setattr(service, "llm", llm)
    monkeypatch.setattr(service, "rag", rag)
    return service, llm, rag


def post_chat(client, **overrides):
    payload: Dict[str, Any] = {"bot_id": BOT_ID, "message": MESSAGE}
    payload.update(overrides)
    return client.post("/api/v1/chat", json=payload)


def legacy_user_prompt() -> str:
    """The user prompt the pipeline built before this checkpoint, computed independently."""
    return build_user_prompt(MESSAGE, GOLDEN_CONTEXT)


class TestTheUnconfiguredRequest:
    @pytest.mark.asyncio
    async def test_the_response_body_is_the_pre_feature_body(self, async_client, pipeline):
        response = await post_chat(async_client)

        assert response.status_code == 200
        assert response.json() == GOLDEN_BODY

    @pytest.mark.asyncio
    async def test_the_response_has_no_keys_beyond_the_pre_feature_ones_and_the_added_fields(
        self, async_client, pipeline
    ):
        """A further new top-level key must be a deliberate act, not an oversight.

        `sources`, `model_used`, `failover_used` and `human_requested` are the fields the
        configuration checkpoints add. Anything else appearing here means a new field reached
        the client-facing payload, which is the boundary the plan keeps saying must not
        happen by accident.
        """
        response = await post_chat(async_client)

        assert set(response.json()) == set(GOLDEN_BODY)
        assert set(response.json()["retrieval"]) == {
            "used_topic_filter",
            "top_score",
            "documents_found",
        }

    @pytest.mark.asyncio
    async def test_the_server_only_retrieval_fields_never_reach_the_body(
        self, async_client, pipeline
    ):
        """`strictness_applied` and `confidence_gate_passed` are for the log, not the browser.

        They are written into every pipeline result and mapped into `RetrievalInfo` by the
        route, so the only thing keeping them off the wire is the schema's `exclude=True`.
        Asserting it here is what makes that a guarantee rather than a reading of Pydantic's
        documentation.
        """
        service, _, _ = pipeline
        result = await service.process_chat(bot_id=BOT_ID, message=MESSAGE)

        # The pipeline does carry them, so the assertion below is about serialisation.
        assert "strictness_applied" in result["retrieval"]
        assert "confidence_gate_passed" in result["retrieval"]

        body = (await post_chat(async_client)).json()
        assert "strictness_applied" not in body["retrieval"]
        assert "confidence_gate_passed" not in body["retrieval"]
        assert "strictness_applied" not in (await post_chat(async_client)).text
        assert "confidence_gate_passed" not in (await post_chat(async_client)).text

    @pytest.mark.asyncio
    async def test_the_model_receives_the_legacy_system_prompt_verbatim(self, async_client, pipeline):
        _, llm, _ = pipeline
        await post_chat(async_client)

        assert llm.calls[0]["system_message"] == get_support_system_prompt()

    @pytest.mark.asyncio
    async def test_the_model_receives_the_legacy_user_prompt_verbatim(self, async_client, pipeline):
        _, llm, _ = pipeline
        await post_chat(async_client)

        assert llm.calls[0]["prompt"] == legacy_user_prompt()

    @pytest.mark.asyncio
    async def test_the_model_is_called_with_temperature_zero_and_no_params(
        self, async_client, pipeline
    ):
        """The call shape, not just the call's result.

        `RecordingLLM.generate` has no `params` parameter, so a pipeline that started offering
        one here would fail this test with a `TypeError` instead of passing a harmless `None`.
        That is the point: "the legacy path is untouched" should be enforced, not observed.
        """
        _, llm, _ = pipeline
        await post_chat(async_client)

        call = llm.calls[0]
        assert call["temperature"] == 0.0
        assert call["model"] is None
        assert set(call) == {"prompt", "system_message", "temperature", "model"}

    @pytest.mark.asyncio
    async def test_retrieval_still_asks_for_three_chunks(self, async_client, pipeline):
        """`top_k` became configurable here, so its unconfigured value is worth pinning."""
        _, _, rag = pipeline
        await post_chat(async_client)

        assert rag.top_scores == [3]

    @pytest.mark.asyncio
    async def test_passing_config_explicitly_as_null_is_the_same_as_omitting_it(
        self, async_client, pipeline
    ):
        """A client that serialises an absent optional field as `null` is not a different
        client, and must not be a different request."""
        omitted = await post_chat(async_client)
        explicit_null = await post_chat(async_client, config=None)

        assert omitted.json() == explicit_null.json()

    @pytest.mark.asyncio
    async def test_the_pipeline_result_carries_debug_but_the_response_does_not(
        self, async_client, pipeline
    ):
        """The debug block holds both prompts and the full chunk text.

        It is built by the pipeline for server-side logging and stripped by the route. Both
        halves matter: the block existing is what makes a failure diagnosable, and its
        absence from the body is what keeps retrieval content out of a customer's thread.
        """
        response = await post_chat(async_client)
        service, _, _ = pipeline

        result = await service.process_chat(bot_id=BOT_ID, message=MESSAGE)
        assert "debug" in result
        assert "debug" not in response.json()
        assert CHUNK_CONTENT not in response.text
        assert get_support_system_prompt() not in response.text


class TestTheUnconfiguredFallbacksAreAlsoUnchanged:
    @pytest.mark.asyncio
    async def test_no_retrieved_knowledge_still_produces_its_own_reason_and_copy(
        self, async_client, pipeline
    ):
        service, llm, _ = pipeline
        service.rag = RecordingRag(results=[])

        response = await post_chat(async_client)
        body = response.json()

        assert body["fallback_required"] is True
        assert body["reason"] == FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE
        assert body["response"] == (
            "I couldn't find any information about that in my knowledge base. "
            "Let me connect you to a human agent."
        )
        assert body["sources"] is None
        # The model was never reached — the pipeline refused before generation.
        assert llm.calls == []

    @pytest.mark.asyncio
    async def test_the_sentinel_in_the_reply_still_produces_its_own_reason_and_copy(
        self, async_client, pipeline
    ):
        _, llm, _ = pipeline
        llm.reply = f"I cannot answer that. {INSUFFICIENT_INFORMATION_SIGNAL}"

        response = await post_chat(async_client)
        body = response.json()

        assert body["fallback_required"] is True
        assert body["reason"] == FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION
        assert body["response"] == "Based on the provided information, I cannot answer your question accurately."

    @pytest.mark.asyncio
    async def test_the_sentinel_in_a_sentence_is_still_detected_by_substring(
        self, async_client, pipeline
    ):
        """The check is unchanged, including its bluntness.

        Detection is a substring match on the whole reply, so prose that happens to contain
        the token is treated as a refusal. That is the pre-feature behaviour and this
        checkpoint does not get to improve it — a "smarter" match here would be an unannounced
        behaviour change on the legacy path.
        """
        _, llm, _ = pipeline
        llm.reply = f"The answer may be {INSUFFICIENT_INFORMATION_SIGNAL} or something else."

        response = await post_chat(async_client)

        assert response.json()["reason"] == FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION

    @pytest.mark.asyncio
    async def test_a_fallback_never_carries_sources(self, async_client, pipeline):
        service, _, _ = pipeline
        service.rag = RecordingRag(results=[])

        response = await post_chat(async_client)

        assert response.json()["sources"] is None


class TestTheUnconfiguredRetrievalRoute:
    @pytest.mark.asyncio
    async def test_a_confident_intent_still_applies_its_topic_filter(self, async_client, pipeline):
        _, _, rag = pipeline
        await post_chat(async_client)

        assert rag.topic_filters == ["faq_match"]

    @pytest.mark.asyncio
    async def test_an_unconfident_classification_still_skips_the_topic_filter(
        self, async_client, pipeline
    ):
        service, _, rag = pipeline
        service.classifier = RecordingClassifier(is_confident=False)

        response = await post_chat(async_client)

        assert rag.topic_filters == [None]
        assert response.json()["retrieval"]["used_topic_filter"] is False

    @pytest.mark.asyncio
    async def test_a_general_support_intent_still_skips_the_topic_filter(
        self, async_client, pipeline
    ):
        service, _, rag = pipeline
        service.classifier = RecordingClassifier(intent="GENERAL_SUPPORT")

        await post_chat(async_client)

        assert rag.topic_filters == [None]
