"""Common shared Pydantic schemas."""

from typing import Any, Generic, TypeVar
from pydantic import BaseModel, Field

T = TypeVar("T")


class ErrorDetail(BaseModel):
    """Schema for standard API error details."""

    code: str = Field(..., description="Machine-readable error identifier")
    message: str = Field(..., description="Human-readable error description")
    details: dict[str, Any] = Field(
        default_factory=dict, description="Additional metadata regarding error"
    )


class StandardResponse(BaseModel, Generic[T]):
    """Generic envelope wrapper for standard API responses."""

    success: bool = Field(default=True, description="Operation success status")
    data: T | None = Field(default=None, description="Payload data")
    error: ErrorDetail | None = Field(default=None, description="Error information if failed")
