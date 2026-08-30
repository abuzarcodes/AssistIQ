"""Health check endpoint router."""

from fastapi import APIRouter

router = APIRouter(tags=["Health"])


@router.get("/health", summary="Health Check Endpoint")
async def health_check():
    """Independent health check endpoint returning basic status."""
    return {
        "status": "ok",
        "service": "assistiq-ai",
    }
