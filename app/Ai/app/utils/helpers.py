"""General helper functions."""

import uuid


def generate_uuid() -> str:
    """Generate random UUID string."""
    return str(uuid.uuid4())


def sanitize_string(value: str) -> str:
    """Strip whitespace and control characters from string."""
    if not value:
        return ""
    return value.strip()
