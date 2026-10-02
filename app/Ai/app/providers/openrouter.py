"""OpenRouter adapter — the first entry in the model catalog.

OpenRouter speaks the OpenAI wire protocol, so this is `ChatOpenAI` pointed at
OpenRouter's base URL. The `grok` branch in `llm_service.py` is the closest existing
analogue and the structure deliberately mirrors it.

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

import logging
from typing import Optional

from app.core.config import settings
from app.core.logging import logger, format_log_context
from app.providers.base import ProviderError, ProviderErrorKind
from app.providers.registry import register

#: Statuses that all mean "our credential is the problem". 403 joins 401/402 because a
#: permission denial is remedied by the same operator action as a rejected key —
#: rotating or re-scoping it — and reporting it as UNKNOWN would send that operator
#: looking in the wrong place.
_AUTH_STATUSES = frozenset({401, 402, 403})


def _normalise_content(content) -> str:
    """Flatten a LangChain message body to plain text.

    Mirrors the openai/grok/gemini branches in `llm_service.py` exactly. It is duplicated
    rather than extracted because those branches are on the legacy path that must stay
    provably unchanged while the model path is introduced — refactoring them into a
    shared helper is a separate, riskier change than this checkpoint warrants.
    """
    if isinstance(content, list):
        return "".join(
            part.get("text", "") if isinstance(part, dict) else str(part) for part in content
        )
    return str(content)


def _status_of(err: BaseException) -> Optional[int]:
    """Pull an HTTP status off an SDK exception, wherever it happens to be.

    `openai` exposes `status_code` directly on most errors and on `err.response` for
    others; checking both avoids pinning this to one SDK version's attribute layout.
    """
    status = getattr(err, "status_code", None)
    if isinstance(status, int):
        return status

    response = getattr(err, "response", None)
    status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


def _is_timeout(err: BaseException) -> bool:
    """Whether the failure was a timeout.

    Checked structurally rather than by importing the SDK's timeout class, so this keeps
    working if `langchain-openai` changes which exception type it raises.
    """
    if isinstance(err, (TimeoutError,)):
        return True
    # asyncio.TimeoutError is an alias of TimeoutError on 3.11+, but not on 3.10.
    return any(cls.__name__ in {"APITimeoutError", "Timeout", "ReadTimeout"} for cls in type(err).__mro__)


def classify_error(err: BaseException) -> tuple[ProviderErrorKind, Optional[int]]:
    """Map a provider exception onto `(kind, status)`.

    The kinds are coarse on purpose: they describe what the caller should *do*, not what
    the provider said. Several statuses collapsing into one kind is the intended shape.
    """
    status = _status_of(err)

    if _is_timeout(err):
        return ProviderErrorKind.TIMEOUT, status
    if status == 400:
        return ProviderErrorKind.BAD_REQUEST, status
    if status in _AUTH_STATUSES:
        return ProviderErrorKind.AUTH, status
    if status == 429:
        return ProviderErrorKind.RATE_LIMIT, status
    if status is not None and 500 <= status < 600:
        return ProviderErrorKind.UPSTREAM, status

    return ProviderErrorKind.UNKNOWN, status


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

        An unconfigured adapter raises **before** building a client, so a missing key
        costs no network round trip and cannot be mistaken for a provider outage.
        """
        if not self.is_configured:
            logger.warning(
                "OpenRouter adapter has no credential configured.",
                extra=format_log_context(
                    operation="provider_generate",
                    provider=self.slug,
                    model_id=model_id,
                    kind=ProviderErrorKind.NOT_CONFIGURED.value,
                ),
            )
            raise ProviderError(
                ProviderErrorKind.NOT_CONFIGURED,
                provider=self.slug,
                model_id=model_id,
            )

        try:
            from langchain_core.messages import HumanMessage, SystemMessage
            from langchain_openai import ChatOpenAI

            messages = []
            if system_message:
                messages.append(SystemMessage(content=system_message))
            messages.append(HumanMessage(content=prompt))

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
            response = await chat.ainvoke(messages)
            return _normalise_content(response.content)

        except ProviderError:
            raise
        except Exception as err:
            kind, status = classify_error(err)
            error = ProviderError(
                kind,
                provider=self.slug,
                model_id=model_id,
                status_code=status,
            )
            error.cause = err

            # A rejected credential is a configuration fault an operator must act on; a
            # throttle or an upstream wobble is worth knowing about but is not urgent.
            # Neither the key nor the prompt ever reaches the log record.
            level = logging.ERROR if kind is ProviderErrorKind.AUTH else logging.WARNING
            logger.log(
                level,
                "OpenRouter call failed: %s",
                kind.value,
                extra=format_log_context(
                    operation="provider_generate",
                    provider=self.slug,
                    model_id=model_id,
                    kind=kind.value,
                    provider_status=status,
                    error_type=err.__class__.__name__,
                ),
            )
            raise error from err


#: Registration happens at import time, and the registry does the importing (see
#: `registry._BUILTIN_MODULES`). Importing this module is therefore a side effect, not a
#: mere definition — which is why `app/providers/__init__.py` does not re-export the
#: class: doing so would import this module on every `app.providers` import and make the
#: lazy load pointless.
register(OpenRouterProvider())
