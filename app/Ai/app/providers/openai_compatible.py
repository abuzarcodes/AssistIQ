"""Generic OpenAI-compatible adapter — one configurable endpoint.

For any service that exposes the OpenAI wire protocol but is not one of the four providers
with a dedicated adapter: Together, Fireworks, DeepInfra, a corporate gateway, or a local
vLLM / Ollama / LM Studio. Rather than a custom adapter per vendor, the endpoint is
configuration: point `OPENAI_COMPATIBLE_BASE_URL` at the service and catalogue whatever
model ids it serves.

Why one slot and not many
-------------------------
A provider row is keyed by `slug`, and `slug` is the contract between three things: this
adapter, the `ai_providers` row, and the descriptor Node sends. Node owns the catalog and
has no provider environment of any kind — it cannot read this service's settings, so it
cannot learn the slug of a provider invented here at runtime. A registry of arbitrary
named endpoints would therefore need a new "create provider" API and a second source of
truth for which slugs exist. One named slot keeps the existing invariant intact: add an
adapter, add a variable, seed a row. Three places, one slug.

The display name is not configuration in that sense — it is presentation, so it lives in
the database and a platform owner can rename it from the dashboard.

Readiness here is stricter than elsewhere
-----------------------------------------
`is_configured` requires **both** a base URL and a credential. A generic provider with no
endpoint is not a provider, and langchain-openai requires an `api_key` value even against a
server that ignores it. Pointing this at a keyless local server therefore means supplying a
placeholder (`not-needed`). That is documented rather than special-cased: a readiness badge
that turns green for an endpoint with no key would be hiding a real misconfiguration, and
this codebase reports configuration problems rather than smoothing them over.
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


class OpenAICompatibleProvider:
    """`LLMProvider` implementation for a configured OpenAI-compatible endpoint."""

    slug = "openai_compatible"

    #: The same five the wire protocol carries. An endpoint that ignores one of them will
    #: accept and discard it, which is the endpoint's business — this adapter's job is to
    #: send what it was asked to send, to a server that speaks the protocol it claims to.
    supported_params = OPENAI_WIRE_PARAMS

    @property
    def is_configured(self) -> bool:
        """Whether both an endpoint and a credential are present. No network call.

        Both, not either — see the module docstring.
        """
        return bool(
            settings.OPENAI_COMPATIBLE_BASE_URL.strip()
            and settings.OPENAI_COMPATIBLE_API_KEY.strip()
        )

    async def generate(
        self,
        prompt: str,
        model_id: str,
        system_message: Optional[str] = None,
        temperature: float = 0.0,
        params: Optional[GenerationParams] = None,
    ) -> str:
        """Run a completion against the configured endpoint, or raise `ProviderError`."""

        async def build_call():
            from langchain_openai import ChatOpenAI

            kwargs = build_client_kwargs(self.supported_params, params)
            kwargs["temperature"] = resolve_temperature(params, temperature)

            chat = ChatOpenAI(
                base_url=settings.OPENAI_COMPATIBLE_BASE_URL,
                model=model_id,
                api_key=settings.OPENAI_COMPATIBLE_API_KEY,
                max_retries=0,
                request_timeout=settings.OPENAI_COMPATIBLE_REQUEST_TIMEOUT,
                **kwargs,
            )
            response = await chat.ainvoke(build_messages(prompt, system_message))
            return response.content

        return await run_completion(
            slug=self.slug,
            label="OpenAI-compatible",
            model_id=model_id,
            configured=self.is_configured,
            build_call=build_call,
            # Handed over so the failure log can strip them back out — see `openai_wire`.
            redact_also=(prompt, system_message or ""),
        )


register(OpenAICompatibleProvider())
