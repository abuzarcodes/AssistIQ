"""Tests for /health endpoint."""

import pytest


@pytest.mark.asyncio
async def test_health_check(async_client):
    """Test GET /health returns 200 OK and expected json payload."""
    response = await async_client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["service"] == "assistiq-ai"
