"""Centralized custom exception definitions and FastAPI exception handlers."""

from typing import Any, Dict
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from app.core.logging import logger, format_log_context


class AssistIQAIException(Exception):
    """Base exception class for AssistIQ AI Service."""

    def __init__(
        self,
        message: str = "An internal AI service error occurred.",
        status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR,
        error_code: str = "INTERNAL_ERROR",
        details: Dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.error_code = error_code
        self.details = details or {}


class MissingConfigurationException(AssistIQAIException):
    """Raised when required environment configurations or API keys are missing."""

    def __init__(self, message: str = "Required service configuration is missing."):
        super().__init__(
            message=message,
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            error_code="CONFIGURATION_MISSING",
        )


class LLMServiceException(AssistIQAIException):
    """Raised when an error occurs during LLM execution."""

    def __init__(self, message: str = "LLM service execution failed."):
        super().__init__(
            message=message,
            status_code=status.HTTP_502_BAD_GATEWAY,
            error_code="LLM_SERVICE_ERROR",
        )


class EmbeddingServiceException(AssistIQAIException):
    """Raised when document/text embedding generation fails."""

    def __init__(self, message: str = "Embedding service execution failed."):
        super().__init__(
            message=message,
            status_code=status.HTTP_502_BAD_GATEWAY,
            error_code="EMBEDDING_SERVICE_ERROR",
        )


class RetrievalException(AssistIQAIException):
    """Raised when context retrieval encounters an issue."""

    def __init__(self, message: str = "Vector retrieval operation failed."):
        super().__init__(
            message=message,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            error_code="RETRIEVAL_ERROR",
        )


class ModelNotFoundException(AssistIQAIException):
    """Raised when an ML model artifact is missing or fails to load."""

    def __init__(self, message: str = "Requested ML model artifact was not found."):
        super().__init__(
            message=message,
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            error_code="MODEL_NOT_FOUND",
        )


def register_exception_handlers(app: FastAPI) -> None:
    """Register custom exception handlers with FastAPI application."""

    @app.exception_handler(AssistIQAIException)
    async def handle_assistiq_exception(
        request: Request, exc: AssistIQAIException
    ) -> JSONResponse:
        logger.error(
            "AssistIQ AI Exception: %s",
            exc.message,
            extra=format_log_context(
                operation="exception_handler",
                error_type=exc.error_code,
            ),
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": exc.error_code,
                    "message": exc.message,
                    "details": exc.details,
                }
            },
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_exception(
        request: Request, exc: Exception
    ) -> JSONResponse:
        logger.exception(
            "Unhandled exception occurred",
            extra=format_log_context(
                operation="unhandled_exception",
                error_type=exc.__class__.__name__,
            ),
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": {
                    "code": "INTERNAL_SERVER_ERROR",
                    "message": "An unexpected error occurred in the AI service.",
                }
            },
        )
