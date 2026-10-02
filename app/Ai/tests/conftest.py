"""Pytest configuration fixtures."""

import os

# Set the service-to-service secret before the app (and therefore app.core.config) is
# imported, so the suite is hermetic and never depends on a developer's local .env.
# An explicit environment variable wins over the .env file in pydantic-settings.
TEST_API_KEY = "test-ai-service-key"
os.environ["AI_SERVICE_API_KEY"] = TEST_API_KEY

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from app.main import app


@pytest_asyncio.fixture
async def async_client():
    """Fixture providing an async HTTP client for FastAPI endpoint testing.

    Sends the shared secret on every request, exactly as the Node backend does. Tests
    that assert unauthenticated behaviour use `unauthenticated_client` or override the
    header themselves.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"X-API-Key": TEST_API_KEY},
    ) as client:
        yield client


@pytest_asyncio.fixture
async def unauthenticated_client():
    """Fixture providing a client that sends no credentials at all."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
