"""Service-to-service authentication for the AI microservice.

The Node backend is the only authorized caller. It proves its identity with a shared
secret sent in the `X-API-Key` header. This dependency is attached to every versioned
router in `main.py`; `/health` is deliberately left open so container and load-balancer
probes keep working.

The dependency is **fail-closed**: when `AI_SERVICE_API_KEY` is not configured the
service refuses every protected request instead of silently allowing unauthenticated
traffic, so a missing secret surfaces as a loud error rather than an open door.
"""

import secrets

from fastapi import Header, HTTPException, status

from app.core.config import settings
from app.core.exceptions import MissingConfigurationException
from app.core.logging import logger, format_log_context


async def require_api_key(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> None:
    """Reject any protected request that does not present the shared secret.

    Raises:
        MissingConfigurationException: 503 when the service has no key configured.
        HTTPException: 401 when the header is absent or does not match.
    """
    expected = settings.AI_SERVICE_API_KEY

    if not expected:
        logger.error(
            "AI_SERVICE_API_KEY is not configured; refusing the request.",
            extra=format_log_context(
                operation="auth",
                error_type="CONFIGURATION_MISSING",
            ),
        )
        raise MissingConfigurationException(
            "AI_SERVICE_API_KEY is not configured on the AI service."
        )

    # compare_digest is constant-time, so a wrong key cannot be recovered by timing.
    # Both sides are encoded because compare_digest rejects non-ASCII str inputs.
    provided = (x_api_key or "").encode("utf-8")
    if not x_api_key or not secrets.compare_digest(provided, expected.encode("utf-8")):
        logger.warning(
            "Rejected request with a missing or invalid X-API-Key.",
            extra=format_log_context(operation="auth", error_type="UNAUTHORIZED"),
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-API-Key.",
        )
