"""Structured logging setup for the AssistIQ AI application.

Reading a log line
------------------
Every line carries the message, then the context attached by `format_log_context` as a
`key=value` suffix::

    [2026-10-03 19:42:11] [ERROR] [assistiq_ai] - openrouter call failed: AUTH | operation=provider_generate provider=openrouter model_id=openai/gpt-4o-mini kind=AUTH fault=ours provider_status=401 error_type=AuthenticationError provider_message="Incorrect API key provided: [redacted]."

Until this module's formatter was written, none of those fields were rendered: the format
string referenced only `%(message)s`, so ~30 call sites carefully attached `provider`,
`model_id`, `kind`, `fault` and the rest to records that then printed none of it. The
context is the point of the whole structured-logging arrangement, so it is rendered here.

`LOG_FORMAT=json` switches to one JSON object per line for log aggregators; the default is
the human-readable form above.

This module deliberately imports nothing from `app`. It is imported by nearly everything
else, and `setup_logging()` runs at import time — if it read `Settings`, a malformed `.env`
would take out logging, which is exactly the moment logs are needed most. `LOG_LEVEL` and
`LOG_FORMAT` are therefore read straight from the environment.
"""

import json
import logging
import os
import re
import sys
from typing import Any, Dict, List, Tuple

#: The order well-known context keys are rendered in, so the same fields always appear in
#: the same place and a line can be scanned rather than read. Anything not listed follows,
#: alphabetically.
_CONTEXT_ORDER: Tuple[str, ...] = (
    "operation",
    "provider",
    "model_id",
    "kind",
    "fault",
    "provider_status",
    "error_type",
    "bot_id",
    "conversation_id",
    "request_id",
    "reason",
    "duration_ms",
)

#: Everything a bare `LogRecord` already carries. Context is "whatever else is on the
#: record", so this is how the formatter tells the two apart without maintaining a second
#: list of field names that could drift from the first.
_RESERVED: frozenset = frozenset(
    logging.LogRecord("", 0, "", 0, "", (), None).__dict__
) | {"asctime", "message", "taskName"}

#: Values matching this are rendered bare; anything else (spaces, quotes, `=`) is JSON-quoted
#: so a value containing a space cannot be mistaken for two fields.
_BARE_VALUE = re.compile(r"^[A-Za-z0-9_.:/@+-]*$")

_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def _context_of(record: logging.LogRecord) -> Dict[str, Any]:
    """The structured context attached to `record`, minus the standard attributes.

    `None` is dropped rather than rendered as `provider_status=None`: a field that is absent
    because it does not apply should not look like a field that was measured and found
    empty. Everything else is kept, so attaching context is enough to have it appear —
    there is no second registry to update and therefore none to forget.
    """
    return {
        key: value
        for key, value in record.__dict__.items()
        if key not in _RESERVED and not key.startswith("_") and value is not None
    }


def _ordered(context: Dict[str, Any]) -> List[Tuple[str, Any]]:
    known = [(key, context[key]) for key in _CONTEXT_ORDER if key in context]
    rest = sorted((key, value) for key, value in context.items() if key not in _CONTEXT_ORDER)
    return known + rest


def _render_value(value: Any) -> str:
    if isinstance(value, str):
        return value if _BARE_VALUE.match(value) else json.dumps(value)
    return str(value)


class ContextFormatter(logging.Formatter):
    """Renders a record's message plus the context its caller attached."""

    def __init__(self, *, style: str = "text", **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._style = "json" if style == "json" else "text"

    def format(self, record: logging.LogRecord) -> str:
        context = dict(_ordered(_context_of(record)))
        message = record.getMessage()

        if self._style == "json":
            payload: Dict[str, Any] = {
                "ts": self.formatTime(record),
                "level": record.levelname,
                "logger": record.name,
                "msg": message,
            }
            payload.update(context)
            if record.exc_info:
                payload["exc"] = self.formatException(record.exc_info)
            return json.dumps(payload, default=str)

        line = f"[{self.formatTime(record)}] [{record.levelname}] [{record.name}] - {message}"
        if context:
            line += " | " + " ".join(
                f"{key}={_render_value(value)}" for key, value in context.items()
            )
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def setup_logging(
    log_level: str | None = None,
    log_format: str | None = None,
) -> logging.Logger:
    """Configure structured console logging.

    Both arguments fall back to the environment, so the module-level `setup_logging()` call
    below picks up `.env` without this module importing the settings object.
    """
    logger = logging.getLogger("assistiq_ai")

    numeric_level = getattr(
        logging, (log_level or os.getenv("LOG_LEVEL", "INFO")).upper(), logging.INFO
    )
    logger.setLevel(numeric_level)

    style = (log_format or os.getenv("LOG_FORMAT", "text")).strip().lower()
    if style not in ("text", "json"):
        # An unrecognised value is a typo, not an instruction to guess. Fall back to the
        # readable form and say so rather than silently emitting nothing parseable.
        style = "text"

    if not logger.handlers:
        logger.addHandler(logging.StreamHandler(sys.stdout))

    handler = logger.handlers[0]
    handler.setLevel(numeric_level)
    handler.setFormatter(ContextFormatter(style=style, datefmt=_DATE_FORMAT))

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
    """Format contextual log details avoiding sensitive contents.

    Returns a flat dict intended for `logger.*(..., extra=...)`, which `ContextFormatter`
    then renders. Callers must not place a credential or a prompt fragment here — this
    helper avoids secrets by never being handed them, not by inspecting what it is given.
    Provider text belongs in a `provider_message` field produced by
    `app.core.redaction.redact`.
    """
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
