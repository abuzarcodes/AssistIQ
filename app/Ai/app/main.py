"""FastAPI Application Entry Point & Factory."""

from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.auth import require_api_key
from app.core.config import settings
from app.core.logging import logger, format_log_context
from app.core.exceptions import register_exception_handlers
from app.api.routes import (
    health_router,
    ai_router,
    classifier_router,
    knowledge_router,
    rag_router,
    chat_router,
    testing_router
)
from app.services.vector_store_service import get_vector_store_service
from app.ml.intent.predict import get_intent_model

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifecycle event handler for application startup and shutdown."""
    logger.info(
        "Starting AssistIQ AI Service",
        extra=format_log_context(
            operation="startup",
            env=settings.APP_ENV,
            version="0.1.0",
        ),
    )
    
    # Initialize Vector DB
    vector_store = get_vector_store_service()
    try:
        await vector_store.connect()
    except Exception as e:
        logger.error(f"Could not connect to Vector DB during startup: {e}")
        
    # Preload ML Model
    get_intent_model()
    
    yield
    
    # Shutdown Vector DB
    await vector_store.disconnect()
    
    logger.info(
        "Shutting down AssistIQ AI Service",
        extra=format_log_context(operation="shutdown"),
    )


def create_app() -> FastAPI:
    """Application factory initializing FastAPI with middleware, routes, and exception handling."""
    app = FastAPI(
        title=settings.APP_NAME,
        description="Independent Python AI/ML microservice for AssistIQ multi-tenant customer support platform.",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs" if settings.APP_ENV == "development" else None,
        redoc_url="/redoc" if settings.APP_ENV == "development" else None,
    )

    # Configure CORS Middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Register Exception Handlers
    register_exception_handlers(app)

    # Register Health Route at root level — intentionally unauthenticated so liveness
    # and readiness probes keep working without the shared secret.
    app.include_router(health_router)

    # Register Versioned API Routers under /api/v1.
    # Every one of them requires the service-to-service API key: the Node backend is the
    # only authorized caller, so the AI service is not reachable directly from a browser
    # or any other container (Checkpoint 5).
    protected = [Depends(require_api_key)]
    app.include_router(ai_router, prefix="/api/v1", dependencies=protected)
    app.include_router(classifier_router, prefix="/api/v1", dependencies=protected)
    app.include_router(knowledge_router, prefix="/api/v1", dependencies=protected)
    app.include_router(rag_router, prefix="/api/v1", dependencies=protected)
    app.include_router(chat_router, prefix="/api/v1", dependencies=protected)
    app.include_router(testing_router, prefix="/api/v1", dependencies=protected)

    return app


app = create_app()
