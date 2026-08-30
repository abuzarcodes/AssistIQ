"""LLM Service providing an abstract interface for response generation."""

from typing import Optional
from app.core.config import settings
from app.core.logging import logger, format_log_context


class LLMService:
    """Service abstraction isolating LLM provider calls."""

    def __init__(self) -> None:
        self.provider = settings.LLM_PROVIDER.lower()
        self.model_name = settings.LLM_MODEL
        self.api_key = settings.LLM_API_KEY
        self._is_configured = bool(self.api_key and self.api_key.strip())

    @property
    def is_configured(self) -> bool:
        """Check whether valid API credentials exist."""
        return self._is_configured

    async def generate(
        self,
        prompt: str,
        system_message: Optional[str] = None,
        temperature: float = 0.7,
    ) -> str:
        """Generate response from configured LLM provider or fallback mock response."""
        if not self.is_configured:
            logger.info(
                "LLM API key not configured. Returning placeholder mock response.",
                extra=format_log_context(operation="llm_generate", provider=self.provider),
            )
            return (
                f"[Placeholder AI Response] Mock response for question: '{prompt}'. "
                "(Set LLM_API_KEY in .env to connect to live LLM provider)."
            )

        try:
            if self.provider == "openai":
                from langchain_openai import ChatOpenAI
                from langchain_core.messages import HumanMessage, SystemMessage

                messages = []
                if system_message:
                    messages.append(SystemMessage(content=system_message))
                messages.append(HumanMessage(content=prompt))

                chat = ChatOpenAI(
                    model=self.model_name,
                    api_key=self.api_key,
                    temperature=temperature,
                )
                response = await chat.ainvoke(messages)
                return str(response.content)
            else:
                return f"[Placeholder AI Response] Unsupported LLM provider '{self.provider}'."

        except Exception as err:
            logger.error(
                "Failed to invoke LLM provider: %s",
                str(err),
                extra=format_log_context(
                    operation="llm_generate",
                    error_type=err.__class__.__name__,
                ),
            )
            return f"[Fallback Response] Unable to contact LLM service. Query was: '{prompt}'."


_llm_service_instance: Optional[LLMService] = None


def get_llm_service() -> LLMService:
    """Dependency injector for LLMService singleton instance."""
    global _llm_service_instance
    if _llm_service_instance is None:
        _llm_service_instance = LLMService()
    return _llm_service_instance
