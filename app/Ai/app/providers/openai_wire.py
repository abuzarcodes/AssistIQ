"""Shared substrate for the OpenAI-wire provider adapters.

Most providers in the catalog speak the OpenAI HTTP protocol: OpenAI itself, Groq,
OpenRouter, and any service behind the generic ``openai_compatible`` slot. They differ in
three things only — where the credential comes from, what base URL to point at, and which
LangChain chat class to construct. Everything else (how a vendor exception becomes a
``ProviderErrorKind``, how a message body is flattened, what gets logged, and above all
what must *never* be logged) is identical, and is defined once here.

`openrouter.py` was the first adapter and carried this logic inline. It now imports from
here and re-exports `classify_error`, so its test module keeps passing unchanged and keeps
acting as the regression net for this extraction.

Gemini does not share the client construction — it uses a different SDK with a different
credential keyword — but it does share `classify_error` and `run_completion`, because its
failure taxonomy and its disclosure obligations are the same.

Why ``run_completion`` takes a callable
---------------------------------------
Client *construction* must sit inside the ``try``: a bad base URL or an incompatible SDK
version fails when the client is built, not when it is invoked, and that failure deserves
the same classification as any other. Passing a callable rather than a built client is what
keeps construction inside the guarded region without this module knowing which SDK is on
the other side of it.
"""

import logging
from typing import Awaitable, Callable, Dict, List, Optional, Sequence

from langchain_core.messages import HumanMessage, SystemMessage

from app.core.logging import logger, format_log_context
from app.core.redaction import redact
from app.providers.base import GenerationParams, ProviderError, ProviderErrorKind, ProviderFault

#: Statuses that all mean "our credential is the problem". 403 joins 401/402 because a
#: permission denial is remedied by the same operator action as a rejected key —
#: rotating or re-scoping it — and reporting it as UNKNOWN would send that operator
#: looking in the wrong place.
_AUTH_STATUSES = frozenset({401, 402, 403})


def build_messages(prompt: str, system_message: Optional[str]) -> List:
    """Assemble the LangChain message list every adapter sends.

    The system message is included only when one was actually supplied. Passing an empty
    `SystemMessage` instead would be a different request, and some providers treat an empty
    system turn as an error rather than as absent.
    """
    messages: List = []
    if system_message:
        messages.append(SystemMessage(content=system_message))
    messages.append(HumanMessage(content=prompt))
    return messages


#: The generation parameters the OpenAI wire protocol accepts, and therefore the ones every
#: adapter speaking it can send. Declared here because it is a property of the *protocol*,
#: which is what this module exists to hold; an adapter still assigns it to its own
#: `supported_params`, so a vendor that diverts from the protocol can override it in the one
#: place that is about that vendor.
OPENAI_WIRE_PARAMS: frozenset = frozenset(
    {"temperature", "top_p", "frequency_penalty", "presence_penalty", "max_tokens"}
)

#: The generation parameters this function intersects, in the order they are reported when
#: dropped. Ordered rather than sorted so a debug line reads like the config UI the operator
#: just used.
#:
#: `temperature` is deliberately **absent**: it is not part of the intersection because it is
#: the one parameter this protocol predates `GenerationParams` with, and `base.resolve_temperature`
#: owns it outright — one value, one owner, one place to read the precedence. It stays in
#: `OPENAI_WIRE_PARAMS` above, which is the capability *declaration*; this tuple is the
#: filter's input, and those are different questions.
_PARAM_NAMES: tuple = ("top_p", "frequency_penalty", "presence_penalty", "max_tokens")


def build_client_kwargs(
    supported: frozenset,
    params: Optional[GenerationParams],
) -> Dict[str, object]:
    """Intersect requested generation parameters with what an adapter can actually send.

    This is the **only** place the two sets of capability knowledge meet, and the rule is
    simple: a value is sent when it was asked for *and* the adapter declares it supports
    it. Anything else is **dropped, not sent**, never coerced and never substituted — a
    provider that receives a parameter it does not understand may reject the whole request,
    and an invented substitute would be a decision this layer has no standing to make.

    Dropping is logged once per field at DEBUG. Not WARNING: a capability mismatch is the
    normal consequence of swapping a model (an operator moves a bot from an OpenAI model to
    a Gemini one and the penalties simply stop being sent), and logging a routine
    configuration at warning level is how a log stops being read.

    Dropped field names go in their own context field rather than interpolated into the
    message, matching `format_log_context`'s use everywhere else. They are parameter names,
    never values and never credentials.

    `temperature` is not handled here — see `_PARAM_NAMES` and `base.resolve_temperature`.
    """
    if params is None:
        return {}

    requested = {name: getattr(params, name) for name in _PARAM_NAMES}

    kwargs: Dict[str, object] = {}
    dropped: List[str] = []
    for name, value in requested.items():
        if value is None:
            continue
        if name not in supported:
            dropped.append(name)
            continue
        kwargs[name] = value

    if dropped:
        logger.debug(
            "Dropping generation parameters this adapter cannot send: %s",
            ", ".join(dropped),
            extra=format_log_context(
                operation="provider_param_filter",
                unsupported_params=",".join(dropped),
            ),
        )

    return kwargs


def normalise_content(content) -> str:
    """Flatten a LangChain message body to plain text.

    Mirrors the openai/grok/gemini branches in `llm_service.py` exactly. Those branches are
    on the legacy path that must stay provably unchanged, so they keep their own copy —
    this is shared among the catalog adapters, which are free to converge.
    """
    if isinstance(content, list):
        return "".join(
            part.get("text", "") if isinstance(part, dict) else str(part) for part in content
        )
    return str(content)


def status_of(err: BaseException) -> Optional[int]:
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


def is_timeout(err: BaseException) -> bool:
    """Whether the failure was a timeout.

    Checked structurally rather than by importing the SDK's timeout class, so this keeps
    working if a vendor SDK changes which exception type it raises.
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
    status = status_of(err)

    if is_timeout(err):
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


def _log_failure(
    *,
    name: str,
    slug: str,
    model_id: str,
    kind: ProviderErrorKind,
    fault: ProviderFault,
    status: Optional[int],
    error: Optional[BaseException],
    redact_also: Sequence[str],
) -> None:
    """Write the one line that makes a provider failure diagnosable.

    Everything an operator needs to decide *whose* problem this is, in a single record: the
    provider, the model, the failure kind, whose fault it is, the HTTP status, the exception
    class, and what the provider actually said.

    A rejected credential is a configuration fault someone must act on, so it is an ERROR; a
    throttle or an upstream wobble is worth knowing about but is not urgent, so it is a
    WARNING. That is the same split `chat_service` uses for the pipeline-level summary.

    The provider's own text passes through `redact` first. That is not optional: a vendor
    auth failure routinely echoes the key back at us, and this is the only place in the
    service that puts third-party text into a log record. The prompt is stripped too, so a
    provider that quotes the request body cannot write the customer's message into the log.
    """
    logger.log(
        logging.ERROR if kind is ProviderErrorKind.AUTH else logging.WARNING,
        "%s call failed: %s",
        name,
        kind.value,
        extra=format_log_context(
            operation="provider_generate",
            provider=slug,
            model_id=model_id,
            kind=kind.value,
            fault=fault.value,
            provider_status=status,
            error_type=error.__class__.__name__ if error is not None else None,
            provider_message=(
                redact(str(error), redact_also=redact_also) if error is not None else None
            ),
        ),
    )


async def run_completion(
    *,
    slug: str,
    model_id: str,
    configured: bool,
    build_call: Callable[[], Awaitable[object]],
    label: Optional[str] = None,
    redact_also: Sequence[str] = (),
) -> str:
    """Run one completion under the shared failure and disclosure policy.

    `build_call` performs the whole provider interaction — constructing the chat client and
    invoking it — and returns the raw message body, which is normalised here.

    An unconfigured adapter raises **before** `build_call` runs, so a missing key costs no
    network round trip and cannot be mistaken for a provider outage.

    `redact_also` carries the prompt and system message so they can be removed from any
    provider text that echoes them back. `message` on the raised error is always one of the
    fixed strings in `base.py`; the original exception is kept on `cause` and logged only
    through `redact`, which strips every configured credential first.
    """
    name = label or slug

    if not configured:
        logger.warning(
            "%s adapter has no credential configured.",
            name,
            extra=format_log_context(
                operation="provider_generate",
                provider=slug,
                model_id=model_id,
                kind=ProviderErrorKind.NOT_CONFIGURED.value,
                fault=ProviderFault.OURS.value,
            ),
        )
        raise ProviderError(
            ProviderErrorKind.NOT_CONFIGURED,
            provider=slug,
            model_id=model_id,
        )

    try:
        return normalise_content(await build_call())

    except ProviderError as err:
        # An adapter may raise a typed error of its own from inside `build_call`; it is
        # already the right shape and must not be re-wrapped. It still gets logged: this
        # branch matching means the generic one below never runs, so without a line here
        # such a failure would leave no trace at all.
        _log_failure(
            name=name,
            slug=slug,
            model_id=model_id,
            kind=err.kind,
            fault=err.fault,
            status=err.provider_status,
            error=err.cause,
            redact_also=redact_also,
        )
        raise
    except Exception as err:
        kind, status = classify_error(err)
        error = ProviderError(
            kind,
            provider=slug,
            model_id=model_id,
            status_code=status,
        )
        error.cause = err

        _log_failure(
            name=name,
            slug=slug,
            model_id=model_id,
            kind=kind,
            fault=error.fault,
            status=status,
            error=err,
            redact_also=redact_also,
        )
        raise error from err
