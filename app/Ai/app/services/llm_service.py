"""LLM Service providing an abstract interface for response generation."""

from typing import Optional
from app.core.config import settings
from app.core.logging import logger, format_log_context
from app.core.redaction import redact
from app.providers import GenerationParams, ProviderModelRef, get_provider
from app.providers.base import fault_for
from app.providers.openai_wire import classify_error


class LLMService:
    """Service abstraction isolating LLM provider calls."""

    def __init__(self) -> None:
        self.provider = settings.LLM_PROVIDER.lower()
        
        if self.provider == "gemini":
            self.model_name = settings.GEMINI_MODEL
            self.api_key = settings.GEMINI_API_KEY
        elif self.provider == "grok":
            self.model_name = settings.GROK_MODEL
            self.api_key = settings.GROK_API_KEY
        else:
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
        temperature: float = 0.0,
        model: Optional[ProviderModelRef] = None,
        params: Optional[GenerationParams] = None,
    ) -> str:
        """Generate a response from the configured LLM provider or a fallback mock response.

        Two distinct paths, and the distinction is the point of this method:

        * ``model is None`` — **exactly the previous behaviour**, unchanged, still driven
          by ``LLM_PROVIDER`` in the environment. This is the path every existing caller
          takes (the RAG generator, the experimental graph, the production pipeline when a
          bot has no model assigned). It is kept verbatim rather than refactored into the
          provider layer, because those callers have no model to name and their behaviour
          must not move by accident.
        * ``model`` supplied — Node resolved a catalog model for this bot, so the
          environment default is bypassed entirely and the named adapter is used.

        The model path deliberately sits **outside** the ``try`` below. A `ProviderError`
        is a typed, reportable failure that the chat pipeline maps to a reason code; if it
        fell into the existing ``except Exception`` it would come back as the
        ``[Fallback Response] ... Query was: '...'`` string, indistinguishable from a real
        answer and carrying the user's prompt into the transcript. Errors here propagate.

        ``params`` is forwarded **only when one was supplied**, and that conditionality is
        deliberate rather than a micro-optimisation: the adapter protocol gained this
        argument after it shipped, so an adapter written against the original signature must
        keep working untouched. `None` already means "no generation parameters", so not
        passing it says the same thing.
        """
        if model is not None:
            provider = get_provider(model.provider)
            if params is None:
                return await provider.generate(
                    prompt=prompt,
                    model_id=model.model_id,
                    system_message=system_message,
                    temperature=temperature,
                )
            return await provider.generate(
                prompt=prompt,
                model_id=model.model_id,
                system_message=system_message,
                temperature=temperature,
                params=params,
            )

        if not self.is_configured:
            logger.info(
                "LLM API key not configured. Returning placeholder mock response.",
                extra=format_log_context(operation="llm_generate", provider=self.provider),
            )
            return (
                f"[Placeholder AI Response] Mock response for question: '{prompt}'. "
                "(Set LLM API Key in .env to connect to live LLM provider)."
            )

        try:
            from langchain_core.messages import HumanMessage, SystemMessage
            messages = []
            if system_message:
                messages.append(SystemMessage(content=system_message))
            messages.append(HumanMessage(content=prompt))

            if self.provider == "openai":
                from langchain_openai import ChatOpenAI
                chat = ChatOpenAI(
                    model=self.model_name,
                    api_key=self.api_key,
                    temperature=temperature,
                )
                response = await chat.ainvoke(messages)
                content = response.content
                if isinstance(content, list):
                    return "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in content)
                return str(content)
                
            elif self.provider == "grok":
                from langchain_openai import ChatOpenAI
                chat = ChatOpenAI(
                    base_url="https://api.x.ai/v1",
                    model=self.model_name,
                    api_key=self.api_key,
                    temperature=temperature,
                )
                response = await chat.ainvoke(messages)
                content = response.content
                if isinstance(content, list):
                    return "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in content)
                return str(content)
                
            elif self.provider == "gemini":
                from langchain_google_genai import ChatGoogleGenerativeAI
                chat = ChatGoogleGenerativeAI(
                    model=self.model_name,
                    google_api_key=self.api_key,
                    temperature=temperature,
                )
                response = await chat.ainvoke(messages)
                content = response.content
                if isinstance(content, list):
                    return "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in content)
                return str(content)
                
            else:
                return f"[Placeholder AI Response] Unsupported LLM provider '{self.provider}'."

        except Exception as err:
            # This branch used to log `str(err)` verbatim — the one place in the service
            # that put a vendor's own words into a log unredacted, and vendor auth errors
            # routinely quote the key straight back. The text still gets logged, because
            # it is what makes the failure diagnosable, but through `redact` and in its own
            # field rather than spliced into the message.
            #
            # `classify_error` is the same classifier the catalog adapters use, so both
            # paths report a failure the same way even though only one of them is typed.
            kind, status = classify_error(err)
            logger.error(
                "Failed to invoke LLM provider: %s",
                kind.value,
                extra=format_log_context(
                    operation="llm_generate",
                    provider=self.provider,
                    kind=kind.value,
                    fault=fault_for(kind).value,
                    provider_status=status,
                    error_type=err.__class__.__name__,
                    provider_message=redact(
                        str(err), redact_also=(prompt, system_message or "")
                    ),
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
