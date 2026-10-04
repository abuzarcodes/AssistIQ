"""The HTTP contract stays backward compatible (plan §23.2, Checkpoint 9).

`test_chat_config_defaults.py` proves the *pipeline* is unchanged when no configuration is
sent. This module proves the **route** is: a request that predates the feature — no `config`,
no `fallback_model` — is accepted, and the response body carries exactly the documented keys,
with the pipeline's `debug` block never serialised.
"""

from typing import Any, Dict, List, Optional

import pytest

from app.services.chat_service import get_chat_service

BOT_ID = "bot_backward_compat"
MESSAGE = "How long do refunds take?"

#: The response keys the API contract exposes. `debug` is deliberately absent — it holds the
#: full retrieval text and both prompts, and the route maps the pipeline result explicitly so
#: a new pipeline key cannot leak into the body by accident.
EXPECTED_KEYS = {
    "status",
    "response",
    "fallback_required",
    "reason",
    "intent",
    "retrieval",
    "sources",
    "model_used",
    "failover_used",
    "human_requested",
}


class StubLLM:
    async def generate(self, prompt, system_message=None, temperature=0.0, model=None) -> str:
        return "Stub answer."


class StubClassifier:
    def classify(self, text: str) -> Dict[str, Any]:
        return {"intent": "faq_match", "confidence": 0.95, "is_confident": True}


class StubRag:
    async def search(self, query, bot_id, top_k=3, topic_filter=None) -> Dict[str, Any]:
        return {
            "query": query,
            "results": [],
            "top_score": 0.0,
            "is_confident": False,
            "used_topic_filter": topic_filter is not None,
        }


@pytest.fixture
def pipeline(monkeypatch):
    service = get_chat_service()
    monkeypatch.setattr(service, "classifier", StubClassifier())
    monkeypatch.setattr(service, "llm", StubLLM())
    monkeypatch.setattr(service, "rag", StubRag())
    return service


class TestTheRouteContract:
    @pytest.mark.asyncio
    async def test_a_pre_feature_request_is_accepted(self, async_client, pipeline):
        response = await async_client.post(
            "/api/v1/chat", json={"bot_id": BOT_ID, "message": MESSAGE}
        )

        assert response.status_code == 200
        # An empty retrieval is a normal fallback, not an error.
        assert response.json()["fallback_required"] is True

    @pytest.mark.asyncio
    async def test_the_body_has_exactly_the_documented_keys(self, async_client, pipeline):
        response = await async_client.post(
            "/api/v1/chat", json={"bot_id": BOT_ID, "message": MESSAGE}
        )

        body = response.json()
        assert set(body.keys()) == EXPECTED_KEYS
        assert "debug" not in body

    @pytest.mark.asyncio
    async def test_absent_optional_fields_default_cleanly(self, async_client, pipeline):
        response = await async_client.post(
            "/api/v1/chat", json={"bot_id": BOT_ID, "message": MESSAGE}
        )

        body = response.json()
        assert body["sources"] is None
        assert body["model_used"] is None
        assert body["failover_used"] is False
        assert body["human_requested"] is False

    @pytest.mark.asyncio
    async def test_an_empty_fallback_model_is_accepted_and_inert(self, async_client, pipeline):
        response = await async_client.post(
            "/api/v1/chat",
            json={
                "bot_id": BOT_ID,
                "message": MESSAGE,
                "model": None,
                "fallback_model": None,
                "config": None,
            },
        )

        assert response.status_code == 200
        assert response.json()["failover_used"] is False