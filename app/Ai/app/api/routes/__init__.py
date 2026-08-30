"""API routes package."""

from app.api.routes.health import router as health_router
from app.api.routes.ai import router as ai_router
from app.api.routes.classifier import router as classifier_router
from app.api.routes.knowledge import router as knowledge_router
from app.api.routes.rag import router as rag_router
from app.api.routes.chat import router as chat_router
from app.api.routes.testing import router as testing_router

__all__ = [
    "health_router",
    "ai_router",
    "classifier_router",
    "knowledge_router",
    "rag_router",
    "chat_router",
    "testing_router",
]
