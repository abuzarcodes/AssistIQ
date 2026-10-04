"""Checkpoint 4 — `human_requested`: a detection, not a decision.

The module under test answers one question — *did the customer ask for a person?* — and the
whole design follows from where it is allowed to be wrong (plan §14.4):

* A **false negative** is an ordinary conversation. The customer asks again, or the bot's own
  fallback escalates them for another reason. Nothing is broken.
* A **false positive** escalates someone who did not ask — visible, disruptive, and it erodes
  trust in escalation as a feature.

So the pattern list is short and specific rather than broad, and a bot configured to answer in
a language the list does not cover gets **no detection at all** rather than an English guess
against, say, German text. The tests below pin both halves of that asymmetry: the English
phrases that must match, the near-misses that must not, and the language gate that turns the
detector off.

One false positive is **known and accepted**, and it is pinned as such at the end of the
pattern table: "are you a real human?" matches `real human`. It is accepted because of what
§14.4 does with a positive — `TRANSFER_AUTOMATICALLY` keeps the model's answer *and* escalates —
so a customer asking whether they are talking to a person is escalated to one, which is exactly
what they wanted. The near-misses that would be genuinely wrong ("I spoke to an agent
yesterday") are the ones the list is shaped to exclude.

Detection is also tested through the pipeline, because the field's *presence* is a separate
claim from the function's correctness: `ChatResponse.human_requested` must be `False` — not
absent, and not detected — for a caller that sends no configuration, since a caller with no
`humanRequestBehavior` has nothing for a positive to serve.
"""

from typing import Any, Dict, List, Optional

import pytest

from app.core.constants import FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION
from app.services.chat_service import get_chat_service
from app.services.escalation_service import detect_human_request

BOT_ID = "bot_human_1"

#: Messages that must be detected, including every example the plan itself names.
REQUESTS = [
    "I want to talk to a human",
    "Can I speak to an agent?",
    "connect me with a real person please",
    "do you have human support?",
    "I need a customer service rep",
    "let me talk to someone",
    "I'd like to speak with a human representative",
    "get me a live agent",
    "TALK TO A HUMAN",
    "talk\n to   a human",
    "Talk to a human!",
]

#: Messages that must not be. The first two are the ones a broader list would wrongly catch.
NON_REQUESTS = [
    "I spoke to an agent yesterday and they said it was fine",
    "how do I talk to my account manager?",
    "is this a bot?",
    "what is your refund policy?",
    "",
    "   ",
    "agent",
    "human",
    "Hello, I have a question about my order",
]


class StubClassifier:
    def classify(self, text: str) -> Dict[str, Any]:
        return {"intent": "faq_match", "confidence": 0.95, "is_confident": True}


class StubRag:
    def __init__(self, results: Optional[List[Dict[str, Any]]] = None) -> None:
        self.results = (
            results
            if results is not None
            else [
                {
                    "id": "chunk_1",
                    "bot_id": BOT_ID,
                    "topic": "REFUND",
                    "content": "Refunds take five business days.",
                    "source_id": "src_1",
                    "metadata": {"source_id": "src_1", "page_number": 1},
                    "score": 0.91,
                }
            ]
        )

    async def search(self, query, bot_id, top_k=3, topic_filter=None) -> Dict[str, Any]:
        top_score = self.results[0]["score"] if self.results else 0.0
        return {
            "query": query,
            "results": self.results,
            "top_score": top_score,
            "is_confident": top_score >= 0.65,
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


@pytest.fixture
def pipeline(monkeypatch):
    service = get_chat_service()
    llm = StubLLM()
    monkeypatch.setattr(service, "classifier", StubClassifier())
    monkeypatch.setattr(service, "rag", StubRag())
    monkeypatch.setattr(service, "llm", llm)
    return service, llm


def post_chat(client, message: str, **overrides):
    payload: Dict[str, Any] = {"bot_id": BOT_ID, "message": message}
    payload.update(overrides)
    return client.post("/api/v1/chat", json=payload)


# --------------------------------------------------------------------------------------
# The detector
# --------------------------------------------------------------------------------------


class TestWhatCountsAsARequest:
    @pytest.mark.parametrize("message", REQUESTS)
    def test_a_request_is_detected(self, message):
        assert detect_human_request(message) is True

    @pytest.mark.parametrize("message", NON_REQUESTS)
    def test_a_near_miss_is_not(self, message):
        assert detect_human_request(message) is False

    def test_case_does_not_matter(self):
        assert detect_human_request("TALK TO A HUMAN") is True

    def test_punctuation_does_not_matter(self):
        assert detect_human_request("Can I talk to a human?!") is True

    def test_whitespace_and_line_breaks_collapse(self):
        assert detect_human_request("talk\n\n   to \t a human") is True

    def test_an_explicit_language_of_english_is_detected(self):
        assert detect_human_request("talk to a human", "en") is True

    def test_the_known_false_positive_is_pinned(self):
        """"Are you a real human?" is detected, and that is accepted rather than overlooked.

        A customer asking whether they are talking to a person is escalated to one, which is
        the outcome they were asking about. The alternative — dropping `real human` from the
        list — would lose "connect me with a real person", which is a genuine request.
        """
        assert detect_human_request("are you a real human or a bot?") is True


class TestTheLanguageGate:
    @pytest.mark.parametrize("language", [None, "", "auto", "AUTO", "en", "EN", "en-US", "en_GB"])
    def test_detection_is_enabled_for_english_and_the_mirroring_states(self, language):
        """`AUTO` and an absent language mean the bot mirrors the customer — not "not English"."""
        assert detect_human_request("talk to a human", language) is True

    @pytest.mark.parametrize("language", ["de", "fr", "es", "ja", "ar", "zh", "DE", "de-AT"])
    def test_a_named_non_english_language_disables_detection(self, language):
        """Disabled rather than guessed: matching English phrases against German is theatre."""
        assert detect_human_request("talk to a human", language) is False

    def test_an_unrecognised_tag_is_treated_as_not_english(self):
        """The conservative answer for a language this code cannot vouch for."""
        assert detect_human_request("talk to a human", "xx") is False

    def test_the_gate_does_not_depend_on_the_message(self):
        """A disabled detector is disabled, not merely less sensitive."""
        assert detect_human_request("TALK TO A HUMAN!!!", "de") is False


# --------------------------------------------------------------------------------------
# Through the pipeline
# --------------------------------------------------------------------------------------


class TestTheResponseField:
    @pytest.mark.asyncio
    async def test_a_detected_request_is_reported(self, async_client, pipeline):
        body = (
            await post_chat(
                async_client, "I want to talk to a human", config={"response_language": "en"}
            )
        ).json()

        assert body["human_requested"] is True

    @pytest.mark.asyncio
    async def test_an_ordinary_message_is_reported_as_false_not_absent(self, async_client, pipeline):
        body = (
            await post_chat(async_client, "How long do refunds take?", config={"response_language": "en"})
        ).json()

        assert body["human_requested"] is False

    @pytest.mark.asyncio
    async def test_a_request_with_no_configuration_is_never_detected(self, async_client, pipeline):
        """No configuration means no `humanRequestBehavior` for a positive to serve.

        Reporting `True` here would hand Node a detection whose policy it never resolved —
        which is why the legacy path stays at the field's default rather than detecting.
        """
        body = (await post_chat(async_client, "I want to talk to a human")).json()

        assert body["human_requested"] is False

    @pytest.mark.asyncio
    async def test_a_non_english_bot_never_reports_a_request(self, async_client, pipeline):
        body = (
            await post_chat(
                async_client, "I want to talk to a human", config={"response_language": "de"}
            )
        ).json()

        assert body["human_requested"] is False

    @pytest.mark.asyncio
    async def test_detection_does_not_change_the_answer(self, async_client, pipeline):
        """§14.4 — the customer gets the model's answer *and* a human; the copy is Node's.

        This service detects and reports. Substituting a transfer message here would take a
        policy decision that belongs to `humanRequestBehavior`, and it would mean the customer
        lost an answer they could have had.
        """
        body = (
            await post_chat(async_client, "I want to talk to a human", config={})
        ).json()

        assert body["response"] == "Stub answer."
        assert body["fallback_required"] is False

    @pytest.mark.asyncio
    async def test_a_detected_request_is_still_reported_when_the_turn_falls_back(
        self, async_client, pipeline
    ):
        """The two are independent: asking for a person does not depend on being answered."""
        service, llm = pipeline
        llm.reply = "I cannot answer that. INSUFFICIENT_INFORMATION"

        body = (await post_chat(async_client, "I want to talk to a human", config={})).json()

        assert body["reason"] == FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION
        assert body["human_requested"] is True

    @pytest.mark.asyncio
    async def test_a_detected_request_is_reported_when_nothing_was_retrieved(
        self, async_client, pipeline
    ):
        service, _ = pipeline
        service.rag = StubRag(results=[])

        body = (await post_chat(async_client, "I want to talk to a human", config={})).json()

        assert body["fallback_required"] is True
        assert body["human_requested"] is True

    @pytest.mark.asyncio
    async def test_the_field_is_present_on_every_response(self, async_client, pipeline):
        """A stable key set is what lets Node read the field unconditionally."""
        body = (await post_chat(async_client, "Hello")).json()

        assert "human_requested" in body
