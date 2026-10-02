"""Tests for /api/v1/ai endpoints."""

import sys
import types

import pytest
from app.core.config import settings
from app.services.llm_service import LLMService


@pytest.mark.asyncio
async def test_ai_status_endpoint(async_client):
    """Test GET /api/v1/ai/status returns status overview."""
    response = await async_client.get("/api/v1/ai/status")
    assert response.status_code == 200
    data = response.json()
    assert data["service"] == "assistiq-ai"
    assert "llm_provider" in data
    assert "llm_configured" in data


@pytest.mark.asyncio
async def test_ai_status_lists_provider_adapters(async_client):
    """Checkpoint 5: the status response reports each registered adapter.

    `slug` presence is readiness axis 1 (the adapter exists); `configured` is axis 2 (a
    credential is present). Neither is a reachability measurement.
    """
    response = await async_client.get("/api/v1/ai/status")

    assert response.status_code == 200
    adapters = response.json()["provider_adapters"]
    by_slug = {entry["slug"]: entry for entry in adapters}

    assert "openrouter" in by_slug
    assert isinstance(by_slug["openrouter"]["configured"], bool)


@pytest.mark.asyncio
async def test_ai_status_reports_unconfigured_when_no_key_is_set(async_client, monkeypatch):
    """An absent key is reported as absent — not hidden, and not an error."""
    monkeypatch.setattr(settings, "OPENROUTER_API_KEY", "")

    response = await async_client.get("/api/v1/ai/status")

    assert response.status_code == 200
    entry = next(e for e in response.json()["provider_adapters"] if e["slug"] == "openrouter")
    assert entry == {"slug": "openrouter", "configured": False}


@pytest.mark.asyncio
async def test_ai_status_discloses_nothing_about_the_credential_beyond_the_boolean(
    async_client, monkeypatch
):
    """The response is rendered in a browser, so a boolean must be the whole disclosure."""
    secret = "sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    monkeypatch.setattr(settings, "OPENROUTER_API_KEY", secret)

    response = await async_client.get("/api/v1/ai/status")
    body = response.text

    assert secret not in body
    assert "sk-or" not in body
    # Not a prefix, a suffix, a length, or the base URL either.
    assert "aaaaaaaa" not in body
    assert settings.OPENROUTER_BASE_URL not in body

    entry = next(e for e in response.json()["provider_adapters"] if e["slug"] == "openrouter")
    assert entry["configured"] is True
    assert set(entry) == {"slug", "configured"}


@pytest.mark.asyncio
async def test_ai_status_makes_no_outbound_provider_request(async_client, monkeypatch):
    """Reading status must never contact a provider.

    The platform dashboard polls this route. A status endpoint that dials a vendor would
    cost money and would start reporting reachability — a claim this service deliberately
    does not make. If anything here ever constructs a client, this fails.
    """
    class Exploding:
        def __init__(self, **kwargs):
            raise AssertionError("the status endpoint contacted the provider SDK")

    module = types.ModuleType("langchain_openai")
    module.ChatOpenAI = Exploding
    monkeypatch.setitem(sys.modules, "langchain_openai", module)

    response = await async_client.get("/api/v1/ai/status")

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_ai_chat_valid_request(async_client):
    """Test POST /api/v1/ai/chat returns expected schema with placeholder response."""
    payload = {
        "bot_id": "bot_test_123",
        "conversation_id": "conv_test_456",
        "message": "How do I reset my password?",
    }
    response = await async_client.post("/api/v1/ai/chat", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "answer" in data
    assert "confidence" in data
    assert "should_escalate" in data
    assert "sources" in data
    assert isinstance(data["sources"], list)


@pytest.mark.asyncio
async def test_ai_chat_validation_error(async_client):
    """Test POST /api/v1/ai/chat with missing required fields fails validation with 422."""
    payload = {
        "bot_id": "bot_test_123",
        # missing conversation_id and message
    }
    response = await async_client.post("/api/v1/ai/chat", json=payload)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_unconfigured_llm_fallback():
    """Test LLMService returns mock fallback when unconfigured without raising exception."""
    service = LLMService()
    # Force unconfigured state for test
    service._is_configured = False
    answer = await service.generate("Test query")
    assert "[Placeholder AI Response]" in answer
