"""AI functionality API endpoints.

Two chat pipelines exist in this service and they are NOT the same thing:

* ``POST /api/v1/chat`` (see ``app/api/routes/chat.py``) is the **production**
  pipeline — classify -> topic-filter -> pgvector retrieval -> grounded LLM ->
  fallback. It is the only chat path the Express backend calls.
* ``POST /api/v1/ai/chat`` (below) is an **experimental** LangGraph variant used
  for local exploration and exercised by ``tests/test_ai.py``. It is not called by
  the Express backend or the browser, and its retrieval node currently runs against
  a placeholder/mock context provider (see ``app/services/retrieval_service.py``).
  It is kept intentionally so the experimental graph stays runnable; do not wire it
  into the production path without moving it off the mock retriever.
"""

from fastapi import APIRouter, Depends, status
from app.schemas.ai import (
    AIChatRequest,
    AIChatResponse,
    AIStatusResponse,
    ProviderAdapterStatus,
    SourceDocument,
)
from app.services.llm_service import LLMService, get_llm_service
from app.services.embedding_service import EmbeddingService, get_embedding_service
from app.agents.graph import run_agent_graph
from app.providers import registered_providers

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
    """Retrieve operational status of LLM and Embedding provider configurations.

    `provider_adapters` reports, per registered adapter, whether a credential is present.
    Reading it calls `is_configured`, which reads settings — **no provider is contacted**.
    That is deliberate: the platform dashboard polls this route, and turning it into a
    liveness probe would both cost money and answer a question ("can we reach them right
    now?") that this service has no business claiming to know.
    """
    return AIStatusResponse(
        service="assistiq-ai",
        status="operational",
        llm_provider=llm_service.provider,
        llm_configured=llm_service.is_configured,
        embedding_provider=embedding_service.provider,
        embedding_configured=embedding_service.is_configured,
        provider_adapters=[
            ProviderAdapterStatus(slug=provider.slug, configured=provider.is_configured)
            for provider in registered_providers()
        ],
    )


@router.post(
    "/chat",
    response_model=AIChatResponse,
    status_code=status.HTTP_200_OK,
    summary="[EXPERIMENTAL] Process AI Chat Query (LangGraph)",
)
async def chat_with_ai(
    payload: AIChatRequest,
):
    """EXPERIMENTAL: run the LangGraph RAG workflow (retrieve -> generate).

    Not the production chat path — use ``POST /api/v1/chat`` for that. Kept so the
    experimental graph remains runnable; retrieval currently uses a mock provider.
    """
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
