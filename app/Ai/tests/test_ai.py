"""Tests for /api/v1/ai endpoints."""

import pytest
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
