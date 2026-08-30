"""Structured logging setup for the AssistIQ AI application."""

import logging
import sys
from typing import Any, Dict


def setup_logging(log_level: str = "INFO") -> logging.Logger:
    """Configure structured console logging."""
    logger = logging.getLogger("assistiq_ai")
    numeric_level = getattr(logging, log_level.upper(), logging.INFO)
    logger.setLevel(numeric_level)

    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setLevel(numeric_level)
        formatter = logging.Formatter(
            fmt="[%(asctime)s] [%(levelname)s] [%(name)s] - %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        handler.setFormatter(formatter)
        logger.addHandler(handler)

    return logger


logger = setup_logging()


def format_log_context(
    operation: str,
    request_id: str | None = None,
    bot_id: str | None = None,
    conversation_id: str | None = None,
    duration_ms: float | None = None,
    error_type: str | None = None,
    **extra: Any,
) -> Dict[str, Any]:
    """Format contextual log details avoiding sensitive contents."""
    context: Dict[str, Any] = {
        "operation": operation,
    }
    if request_id:
        context["request_id"] = request_id
    if bot_id:
        context["bot_id"] = bot_id
    if conversation_id:
        context["conversation_id"] = conversation_id
    if duration_ms is not None:
        context["duration_ms"] = round(duration_ms, 2)
    if error_type:
        context["error_type"] = error_type
    
    # Merge additional safe metadata
    context.update(extra)
    return context
