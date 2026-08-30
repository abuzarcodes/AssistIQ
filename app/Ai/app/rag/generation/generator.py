"""Answer generator coordinating prompts and LLM execution."""

from typing import List, Optional
from app.services.llm_service import LLMService, get_llm_service
from app.rag.generation.prompts import RAG_GROUNDING_SYSTEM_PROMPT, build_rag_user_prompt


class AnswerGenerator:
    """Combines user query, retrieved context, grounding prompts, and LLM execution."""

    def __init__(self, llm_service: Optional[LLMService] = None) -> None:
        self.llm_service = llm_service or get_llm_service()

    async def generate_answer(
        self,
        question: str,
        context_snippets: List[str],
    ) -> str:
        """Generate grounded answer using LLM service."""
        user_prompt = build_rag_user_prompt(question, context_snippets)
        return await self.llm_service.generate(
            prompt=user_prompt,
            system_message=RAG_GROUNDING_SYSTEM_PROMPT,
        )
