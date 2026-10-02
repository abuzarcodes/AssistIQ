"""Tests for the service-to-service API key boundary (Checkpoint 5).

The AI service must not be reachable without the shared secret. These tests pin both
halves of the contract: unauthenticated callers are rejected, and the Node backend's
credential (simulated by the `async_client` fixture, which sends the same header) works.
"""

import pytest

from app.core.config import settings

# One representative route per protected router.
PROTECTED_ROUTES = [
    ("GET", "/api/v1/ai/status"),
    ("GET", "/api/v1/ml/status"),
    ("POST", "/api/v1/rag/search"),
    ("GET", "/api/v1/testing/status"),
]


async def _call(client, method: str, url: str):
    if method == "GET":
        return await client.get(url)
    return await client.post(url, json={})


@pytest.mark.asyncio
@pytest.mark.parametrize("method,route", PROTECTED_ROUTES)
async def test_requests_without_key_are_rejected(unauthenticated_client, method, route):
    """A direct caller with no credentials gets 401, never the resource."""
    response = await _call(unauthenticated_client, method, route)
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid or missing X-API-Key."


@pytest.mark.asyncio
async def test_wrong_key_is_rejected(unauthenticated_client):
    """A guessed key is rejected exactly like a missing one."""
    response = await unauthenticated_client.get(
        "/api/v1/ai/status", headers={"X-API-Key": "not-the-key"}
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_correct_key_is_accepted(async_client):
    """The Node backend's credential is accepted."""
    response = await async_client.get("/api/v1/ai/status")
    assert response.status_code == 200
    assert response.json()["service"] == "assistiq-ai"


@pytest.mark.asyncio
async def test_health_remains_open(unauthenticated_client):
    """Probes must keep working without the shared secret."""
    response = await unauthenticated_client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_unconfigured_key_refuses_everything(unauthenticated_client, monkeypatch):
    """Fail-closed: with no key configured the service refuses requests (503), not 200."""
    monkeypatch.setattr(settings, "AI_SERVICE_API_KEY", "")
    response = await unauthenticated_client.get(
        "/api/v1/ai/status", headers={"X-API-Key": "any-key-at-all"}
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "CONFIGURATION_MISSING"
