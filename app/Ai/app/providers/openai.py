"""OpenAI adapter — the first-party API.

The shortest of the catalog adapters, and deliberately so: `ChatOpenAI` with no `base_url`
*is* the OpenAI wire protocol, and the operator supplies only a credential.

`OPENAI_API_KEY`, not `LLM_API_KEY`
-----------------------------------
The legacy path above has a generic `LLM_API_KEY` that holds whatever `LLM_PROVIDER`
points at — with `LLM_PROVIDER=gemini` it holds a Gemini key. Reading it here would make
`GET /ai/status` report OpenAI as configured on the strength of someone else's credential.
The catalogue reads `OPENAI_API_KEY` and nothing else, so an operator who has set only the
legacy variable sees this provider as "credential missing" — which is true, and is the
answer that tells them what to do.
"""

from typing import Optional

from app.core.config import settings
from app.providers.base import GenerationParams, resolve_temperature
from app.providers.openai_wire import (
    OPENAI_WIRE_PARAMS,
    build_client_kwargs,
    build_messages,
    run_completion,
)
from app.providers.registry import register


class OpenAIProvider:
    """`LLMProvider` implementation for OpenAI."""

    slug = "openai"

    supported_params = OPENAI_WIRE_PARAMS

    @property
    def is_configured(self) -> bool:
        """Whether a credential is present. Settings only — no network call.

        A blank key and a whitespace-only key are both absent: a key of spaces is a
        misconfiguration, not a credential.
        """
        return bool(settings.OPENAI_API_KEY.strip())

    async def generate(
        self,
        prompt: str,
        model_id: str,
        system_message: Optional[str] = None,
        temperature: float = 0.0,
        params: Optional[GenerationParams] = None,
    ) -> str:
        """Run a completion against OpenAI, or raise `ProviderError`."""

        async def build_call():
            from langchain_openai import ChatOpenAI

            # Only the parameters this adapter can actually send survive the intersection;
            # anything else is dropped and reported once at DEBUG. See `build_client_kwargs`.
            kwargs = build_client_kwargs(self.supported_params, params)
            # `temperature` has two possible sources and one owner; the precedence between
            # them lives in `resolve_temperature` rather than in this line.
            kwargs["temperature"] = resolve_temperature(params, temperature)

            chat = ChatOpenAI(
                base_url=settings.OPENAI_BASE_URL,
                model=model_id,
                api_key=settings.OPENAI_API_KEY,
                # Node's failure policy owns retries — see `openai_wire.run_completion`.
                max_retries=0,
                request_timeout=settings.OPENAI_REQUEST_TIMEOUT,
                **kwargs,
            )
            response = await chat.ainvoke(build_messages(prompt, system_message))
            return response.content

        return await run_completion(
            slug=self.slug,
            label="OpenAI",
            model_id=model_id,
            configured=self.is_configured,
            build_call=build_call,
            # Handed over so the failure log can strip them back out — see `openai_wire`.
            redact_also=(prompt, system_message or ""),
        )


register(OpenAIProvider())
