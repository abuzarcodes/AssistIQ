"""AI functionality API endpoints."""

from fastapi import APIRouter, Depends, status
from app.schemas.ai import AIChatRequest, AIChatResponse, AIStatusResponse, SourceDocument
from app.services.llm_service import LLMService, get_llm_service
from app.services.embedding_service import EmbeddingService, get_embedding_service
from app.agents.graph import run_agent_graph

router = APIRouter(prefix="/ai", tags=["AI"])


@router.get(
    "/status",
    response_model=AIStatusResponse,
    summary="Get AI Service & Models Status",
)
async def get_ai_status(
    llm_service: LLMService = Depends(get_llm_service),
    embedding_service: EmbeddingService = Depends(get_embedding_service),
):
    """Retrieve operational status of LLM and Embedding provider configurations."""
    return AIStatusResponse(
        service="assistiq-ai",
        status="operational",
        llm_provider=llm_service.provider,
        llm_configured=llm_service.is_configured,
        embedding_provider=embedding_service.provider,
        embedding_configured=embedding_service.is_configured,
    )


@router.post(
    "/chat",
    response_model=AIChatResponse,
    status_code=status.HTTP_200_OK,
    summary="Process AI Chat Query",
)
async def chat_with_ai(
    payload: AIChatRequest,
):
    """Process incoming chat query using LangGraph RAG pipeline."""
    # Execute LangGraph workflow
    result = await run_agent_graph(
        question=payload.message,
        bot_id=payload.bot_id,
        conversation_id=payload.conversation_id,
        workspace_id=payload.workspace_id,
    )

    # Convert raw sources dict to SourceDocument Pydantic objects
    raw_sources = result.get("sources", [])
    sources_list = [SourceDocument(**doc) for doc in raw_sources]

    return AIChatResponse(
        answer=result.get("answer", ""),
        intent=result.get("intent"),
        should_escalate=result.get("should_escalate", False),
        confidence=result.get("retrieval_confidence", 0.0),
        sources=sources_list,
    )
