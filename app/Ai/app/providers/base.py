"""Provider-agnostic LLM adapter contract.

Trust boundary
--------------
The Node backend owns the model catalog and is the only component that can decide
*which* provider/model pair a bot is allowed to use. It hands Python a descriptor:

    {"provider": "openrouter", "model_id": "openai/gpt-4o-mini"}

Python validates the **first half** of that — the provider slug, against the registry
in `registry.py`. It deliberately cannot validate the second half: this service holds
no catalog, no connection to the Node database, and no notion of which models an
operator has enabled. That asymmetry is intentional and load-bearing:

* Node is the sole authority on model enablement, and re-reads catalog state on every
  message, so a disable takes effect immediately.
* Python trusts the slug only far enough to pick an adapter, and trusts the model id
  not at all beyond passing it to that adapter.

The consequence: a bug in Node's validation could name a model Python would happily
call. The defence is on the Node side (`assignBotModel` resolves through the catalog),
not here. Do not add a "known models" list to this service — a second copy of catalog
state is a second thing that can disagree with the first.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Optional, Protocol

from app.core.exceptions import AssistIQAIException


class ProviderErrorKind(str, Enum):
    """Machine-readable failure classes a provider adapter can report.

    These are the vocabulary the Node-side failure policy maps onto user-visible
    behaviour (Checkpoint 6). They are *kinds*, not statuses: several HTTP statuses
    collapse into one kind (`401` and `402` are both `AUTH`), because what the caller
    can do about them is identical.

    Inheriting `str` makes each member compare equal to its own name, so a kind can be
    logged, serialised or pattern-matched without an explicit `.value`.
    """

    #: No credential is present. Detected before any network call is attempted.
    NOT_CONFIGURED = "NOT_CONFIGURED"
    #: The provider rejected our credential, or the account cannot pay for the request.
    AUTH = "AUTH"
    #: We are being throttled. Retrying later is the only sane response.
    RATE_LIMIT = "RATE_LIMIT"
    #: The provider failed on its side (5xx).
    UPSTREAM = "UPSTREAM"
    #: The request did not complete in time.
    TIMEOUT = "TIMEOUT"
    #: The provider rejected the request itself (400) — usually a bad model id.
    BAD_REQUEST = "BAD_REQUEST"
    #: The descriptor named a provider this service has no adapter for.
    UNKNOWN_PROVIDER = "UNKNOWN_PROVIDER"
    #: Anything else. Deliberately a bucket rather than a guess.
    UNKNOWN = "UNKNOWN"


#: Fixed, non-echoing messages. A provider exception's own text is never used as the
#: message: it can contain the request URL, headers, or fragments of the prompt.
_DEFAULT_MESSAGES: dict[ProviderErrorKind, str] = {
    ProviderErrorKind.NOT_CONFIGURED: "The provider is not configured.",
    ProviderErrorKind.AUTH: "The provider rejected the credentials.",
    ProviderErrorKind.RATE_LIMIT: "The provider is rate limiting this account.",
    ProviderErrorKind.UPSTREAM: "The provider reported an internal error.",
    ProviderErrorKind.TIMEOUT: "The provider did not respond in time.",
    ProviderErrorKind.BAD_REQUEST: "The provider rejected the request.",
    ProviderErrorKind.UNKNOWN_PROVIDER: "No adapter is registered for that provider.",
    ProviderErrorKind.UNKNOWN: "The provider call failed.",
}


class ProviderError(AssistIQAIException):
    """A typed provider failure, carrying a `kind` the caller can branch on.

    Subclassing `AssistIQAIException` means an *unmapped* `ProviderError` still leaves
    the service as a `502` with the standard error envelope rather than a bare `500` —
    a provider being unavailable is an upstream fault, not a bug in this service. The
    chat pipeline maps it to a reason-coded response well before that (Checkpoint 6);
    this is the floor, not the policy.

    `message` is always one of the fixed strings above. The original exception is kept
    on `cause` for logs only — never rendered.
    """

    def __init__(
        self,
        kind: ProviderErrorKind,
        message: Optional[str] = None,
        *,
        provider: Optional[str] = None,
        model_id: Optional[str] = None,
        status_code: Optional[int] = None,
    ):
        super().__init__(
            message=message or _DEFAULT_MESSAGES[kind],
            status_code=502,
            error_code="PROVIDER_ERROR",
            details={
                "kind": kind.value,
                # Provider slug and model id are public identifiers — they appear in the
                # platform dashboard. No credential-derived value may ever be added here.
                "provider": provider,
                "model_id": model_id,
                "provider_status": status_code,
            },
        )
        self.kind = kind
        self.provider = provider
        self.model_id = model_id
        self.provider_status = status_code
        #: The underlying exception, for logging only. Never serialised.
        self.cause: Optional[BaseException] = None


@dataclass(frozen=True)
class ProviderModelRef:
    """The descriptor Node sends: which adapter to use, and which model to ask it for.

    Frozen because it is a value handed across a process boundary. Nothing downstream
    should be able to mutate which model a request is running against.
    """

    provider: str
    model_id: str


class LLMProvider(Protocol):
    """What the registry requires of an adapter.

    A `Protocol` rather than a base class: adapters differ in how they talk to their
    vendor, and the only thing the rest of the service needs is this trio. There is no
    `@runtime_checkable` here — the registry dispatches by slug, never by `isinstance`,
    and a runtime-checkable protocol with a property member is a footgun.
    """

    #: The stable identifier Node uses in the descriptor. Must match the `slug` column
    #: of the `ai_providers` row, and must never change once shipped.
    slug: str

    @property
    def is_configured(self) -> bool:
        """Whether a credential is present. A configuration check — no network call.

        This is what `GET /ai/status` reports, and it must stay cheap and side-effect
        free: the platform dashboard polls it, and a request to a vendor from a status
        endpoint would be both a cost and a lie (it measures reachability, which this
        deliberately does not).
        """
        ...

    async def generate(
        self,
        prompt: str,
        model_id: str,
        system_message: Optional[str] = None,
        temperature: float = 0.0,
    ) -> str:
        """Produce a completion, or raise `ProviderError`.

        Implementations must raise `ProviderError` rather than returning an error
        string: Node's failure policy branches on the kind, and a string that merely
        looks like a failure would be indistinguishable from a real answer.
        """
        ...
