"""OpenRouter adapter — the first entry in the model catalog.

OpenRouter speaks the OpenAI wire protocol, so this is `ChatOpenAI` pointed at
OpenRouter's base URL. The `grok` branch in `llm_service.py` is the closest existing
analogue and the structure deliberately mirrors it.

The failure taxonomy, the content flattening and the disclosure rules this adapter obeys
live in `openai_wire.py`, shared with the other OpenAI-wire adapters. What is left here is
what is genuinely OpenRouter's: where its credential comes from, where to point, and the
two attribution headers it displays on its dashboard.

Where the credential lives
--------------------------
`OPENROUTER_API_KEY` is read from this service's settings and used for exactly one
thing: the `api_key` argument of a request. It is never logged, never placed in an
exception message, never returned in a response model, and never sent to Node. The
platform dashboard learns only a boolean — `is_configured` — which is the entire
disclosure about the credential.

What this adapter deliberately does not do
------------------------------------------
It does not decide *whether* a model may be used. That is Node's job: Node owns the
catalog, and it re-reads model/provider enablement on every message. By the time a
descriptor reaches here it has already been authorised. Adding a second opinion here
would create a second source of truth that can disagree with the first.
"""

from typing import Optional

from app.core.config import settings
from app.providers.openai_wire import build_messages, classify_error, run_completion
from app.providers.registry import register

#: `classify_error` is re-exported rather than merely imported: `tests/test_openrouter.py`
#: imports it from this module and pins the whole mapping table. Leaving that import path
#: intact is what makes the extraction into `openai_wire.py` provable — the tests were not
#: touched, so their passing is evidence the behaviour did not move.
__all__ = ["OpenRouterProvider", "classify_error"]


class OpenRouterProvider:
    """`LLMProvider` implementation for OpenRouter."""

    slug = "openrouter"

    @property
    def is_configured(self) -> bool:
        """Whether a credential is present.

        Reads settings only — no network call. `GET /ai/status` reports this, and that
        endpoint is polled by the platform dashboard, so it must stay free and must not
        become an accidental liveness probe of the provider.
        """
        return bool(settings.OPENROUTER_API_KEY.strip())

    def _headers(self) -> dict:
        """Attribution headers OpenRouter shows on its dashboard.

        Sent only when configured. They identify the *application*, never the account —
        no credential-derived value belongs here.
        """
        headers = {}
        if settings.OPENROUTER_SITE_URL.strip():
            headers["HTTP-Referer"] = settings.OPENROUTER_SITE_URL.strip()
        if settings.OPENROUTER_APP_NAME.strip():
            headers["X-Title"] = settings.OPENROUTER_APP_NAME.strip()
        return headers

    async def generate(
        self,
        prompt: str,
        model_id: str,
        system_message: Optional[str] = None,
        temperature: float = 0.0,
    ) -> str:
        """Run a completion against OpenRouter, or raise `ProviderError`.

        An unconfigured adapter raises before the client is built, so a missing key costs
        no network round trip and cannot be mistaken for a provider outage.
        """

        async def build_call():
            from langchain_openai import ChatOpenAI

            chat = ChatOpenAI(
                base_url=settings.OPENROUTER_BASE_URL,
                model=model_id,
                api_key=settings.OPENROUTER_API_KEY,
                temperature=temperature,
                # Retries are off deliberately: Node's failure policy decides whether a
                # request is retried, and a hidden retry loop here would multiply spend
                # and stretch the request past the caller's own timeout.
                max_retries=0,
                request_timeout=settings.OPENROUTER_REQUEST_TIMEOUT,
                default_headers=self._headers() or None,
            )
            response = await chat.ainvoke(build_messages(prompt, system_message))
            return response.content

        return await run_completion(
            slug=self.slug,
            label="OpenRouter",
            model_id=model_id,
            configured=self.is_configured,
            build_call=build_call,
            # The prompt and system message are handed over purely so the failure log can
            # strip them back out: a provider that quotes the request in its error would
            # otherwise write the customer's message into this service's log.
            redact_also=(prompt, system_message or ""),
        )


#: Registration happens at import time, and the registry does the importing (see
#: `registry._BUILTIN_MODULES`). Importing this module is therefore a side effect, not a
#: mere definition — which is why `app/providers/__init__.py` does not re-export the
#: class: doing so would import this module on every `app.providers` import and make the
#: lazy load pointless.
register(OpenRouterProvider())
