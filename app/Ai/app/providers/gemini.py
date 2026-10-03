"""Google Gemini adapter.

Gemini is the one catalog provider that is not OpenAI-wire: it uses
`langchain_google_genai.ChatGoogleGenerativeAI`, takes its credential as `google_api_key`
rather than `api_key`, and returns message bodies in its own shape. It therefore shares only
`run_completion` and `normalise_content` with the OpenAI-wire adapters — which is exactly
the split `openai_wire.py` was factored along: the envelope is common, the client is not.

The credential is `GEMINI_API_KEY`, the same variable the legacy env-driven path uses.
Deliberately one variable rather than two: a second one could disagree with the first, and
the platform dashboard would then report Gemini as configured or not depending on which one
an operator happened to set. `GEMINI_MODEL` belongs to the legacy path and is not consulted
here — the catalog supplies a model id per request.
"""

from typing import Optional

from app.core.config import settings
from app.providers.openai_wire import build_messages, run_completion
from app.providers.registry import register


class GeminiProvider:
    """`LLMProvider` implementation for Google Gemini."""

    slug = "gemini"

    @property
    def is_configured(self) -> bool:
        """Whether a credential is present. Settings only — no network call."""
        return bool(settings.GEMINI_API_KEY.strip())

    async def generate(
        self,
        prompt: str,
        model_id: str,
        system_message: Optional[str] = None,
        temperature: float = 0.0,
    ) -> str:
        """Run a completion against Gemini, or raise `ProviderError`."""

        async def build_call():
            from langchain_google_genai import ChatGoogleGenerativeAI

            chat = ChatGoogleGenerativeAI(
                model=model_id,
                # The SDK's own keyword. `api_key` is accepted as an alias but reads as
                # though it might be a generic OpenAI-style key; `google_api_key` cannot
                # be mistaken for one.
                google_api_key=settings.GEMINI_API_KEY,
                temperature=temperature,
                max_retries=0,
                timeout=settings.GEMINI_REQUEST_TIMEOUT,
            )
            response = await chat.ainvoke(build_messages(prompt, system_message))
            return response.content

        return await run_completion(
            slug=self.slug,
            label="Gemini",
            model_id=model_id,
            configured=self.is_configured,
            build_call=build_call,
            # Handed over so the failure log can strip them back out — see `openai_wire`.
            redact_also=(prompt, system_message or ""),
        )


register(GeminiProvider())
