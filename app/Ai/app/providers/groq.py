"""Groq adapter — fast inference on open-weight models.

Groq is **not** Grok. Groq (groq.com) runs open-weight models on custom hardware; Grok is
xAI's model family, whose credential is the legacy `GROK_API_KEY`. The names differ by one
letter; the companies, the APIs and the credentials are unrelated. This adapter reads
`GROQ_API_KEY` and nothing else.

Groq exposes an OpenAI-compatible API, so the wire behaviour is the shared one — but the
client is `langchain_groq.ChatGroq` rather than `ChatOpenAI`, because the dedicated
integration carries Groq's own model metadata and defaults. That is also why the shared
envelope in `openai_wire.py` takes a callable: each adapter builds its own client, and only
the failure policy is common.
"""

from typing import Optional

from app.core.config import settings
from app.providers.openai_wire import build_messages, run_completion
from app.providers.registry import register


class GroqProvider:
    """`LLMProvider` implementation for Groq."""

    slug = "groq"

    @property
    def is_configured(self) -> bool:
        """Whether a credential is present. Settings only — no network call."""
        return bool(settings.GROQ_API_KEY.strip())

    async def generate(
        self,
        prompt: str,
        model_id: str,
        system_message: Optional[str] = None,
        temperature: float = 0.0,
    ) -> str:
        """Run a completion against Groq, or raise `ProviderError`."""

        async def build_call():
            from langchain_groq import ChatGroq

            chat = ChatGroq(
                # `GROQ_BASE_URL` is the host (`https://api.groq.com`), deliberately without
                # the `/openai/v1` the other adapters' bases carry: `groq`'s SDK appends
                # `/openai/v1/chat/completions` itself, so an OpenAI-compatible base here
                # double-prefixes the path and every call 404s. See `config.py`.
                base_url=settings.GROQ_BASE_URL,
                model=model_id,
                api_key=settings.GROQ_API_KEY,
                temperature=temperature,
                max_retries=0,
                request_timeout=settings.GROQ_REQUEST_TIMEOUT,
            )
            response = await chat.ainvoke(build_messages(prompt, system_message))
            return response.content

        return await run_completion(
            slug=self.slug,
            label="Groq",
            model_id=model_id,
            configured=self.is_configured,
            build_call=build_call,
            # Handed over so the failure log can strip them back out — see `openai_wire`.
            redact_also=(prompt, system_message or ""),
        )


register(GroqProvider())
