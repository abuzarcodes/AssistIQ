"""FastAPI Application Entry Point & Factory."""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.logging import logger, format_log_context
from app.core.exceptions import register_exception_handlers
from app.api.routes.health import router as health_router
from app.api.routes.ai import router as ai_router


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
    yield
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

    # Register Health Route at root level
    app.include_router(health_router)

    # Register Versioned API Routers under /api/v1
    app.include_router(ai_router, prefix="/api/v1")

    return app


app = create_app()
