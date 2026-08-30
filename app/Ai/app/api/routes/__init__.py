"""API routes package."""

from app.api.routes.health import router as health_router
from app.api.routes.ai import router as ai_router

__all__ = ["health_router", "ai_router"]
