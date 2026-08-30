"""LangGraph node implementations for retrieval and answer generation."""

from typing import Dict, Any
from app.agents.state import AgentState
from app.services.retrieval_service import get_retrieval_service
from app.services.llm_service import get_llm_service
from app.services.ml_service import get_ml_service
from app.rag.generation.prompts import RAG_GROUNDING_SYSTEM_PROMPT, build_rag_user_prompt


async def retrieve_node(state: AgentState) -> Dict[str, Any]:
    """Retrieve relevant context snippets and classify intent."""
    retrieval_service = get_retrieval_service()
    ml_service = get_ml_service()

    question = state["question"]
    bot_id = state["bot_id"]
    workspace_id = state.get("workspace_id")

    sources = await retrieval_service.search_context(
        query=question,
        bot_id=bot_id,
        workspace_id=workspace_id,
    )

    context_snippets = [doc.content for doc in sources]
    sources_dict = [doc.model_dump() for doc in sources]
    confidence = sources[0].score if sources else 0.0

    # ML intent prediction
    intent_data = await ml_service.predict_intent_for_text(question)
    intent = intent_data["intent"]

    # ML escalation check
    escalation_data = await ml_service.predict_human_escalation(
        retrieval_confidence=confidence,
        message_length=len(question),
        intent=intent,
    )

    return {
        "retrieved_context": context_snippets,
        "sources": sources_dict,
        "retrieval_confidence": confidence,
        "intent": intent,
        "should_escalate": escalation_data["should_escalate"],
    }


async def generate_node(state: AgentState) -> Dict[str, Any]:
    """Generate grounded answer using LLM service based on state context."""
    llm_service = get_llm_service()
    question = state["question"]
    context_snippets = state.get("retrieved_context", [])

    user_prompt = build_rag_user_prompt(question, context_snippets)
    answer = await llm_service.generate(
        prompt=user_prompt,
        system_message=RAG_GROUNDING_SYSTEM_PROMPT,
    )

    return {"answer": answer}
