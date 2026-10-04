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


class ProviderFault(str, Enum):
    """Whose problem a failure is.

    A `kind` says what to *do*; it deliberately does not say whose fault it is, and those
    are different questions. `AUTH` and `UPSTREAM` both mean "report a model failure", but
    one is fixed by rotating a key in this service's environment and the other is fixed by
    nobody here at all. Logging the fault alongside the kind is what lets an operator
    decide in one glance whether to open their own `.env` or the provider's status page.
    """

    #: A configuration or integration fault on this side — a missing or rejected
    #: credential, a model id we sent that does not exist, an adapter never deployed.
    OURS = "ours"
    #: The provider's own fault. Nothing here to fix.
    PROVIDER = "provider"
    #: Not attributable without guessing. Used where the evidence genuinely does not
    #: distinguish the two sides; the `kind` still carries the specific failure.
    UNKNOWN = "unknown"


#: Total by design: every kind maps to a fault, and
#: `test_every_kind_has_a_fault` fails if a kind is added without one. A new kind that
#: silently defaulted to `unknown` would be a diagnostic that lies about how much is known.
_FAULTS: dict[ProviderErrorKind, ProviderFault] = {
    ProviderErrorKind.NOT_CONFIGURED: ProviderFault.OURS,
    # A rejected key, a permission denial or an unfunded account are all remedied by the
    # same operator action here, and none of them is the provider malfunctioning.
    ProviderErrorKind.AUTH: ProviderFault.OURS,
    # A 400 is overwhelmingly "the model id we sent does not exist" — our catalog's
    # problem, not theirs.
    ProviderErrorKind.BAD_REQUEST: ProviderFault.OURS,
    ProviderErrorKind.UNKNOWN_PROVIDER: ProviderFault.OURS,
    ProviderErrorKind.RATE_LIMIT: ProviderFault.PROVIDER,
    ProviderErrorKind.UPSTREAM: ProviderFault.PROVIDER,
    # A timeout could be our egress or their latency, and this code cannot tell which.
    # Blaming the provider would send an operator to a status page that is already green.
    ProviderErrorKind.TIMEOUT: ProviderFault.UNKNOWN,
    ProviderErrorKind.UNKNOWN: ProviderFault.UNKNOWN,
}


def fault_for(kind: ProviderErrorKind) -> ProviderFault:
    """The fault class for `kind`, defaulting to `UNKNOWN` for a kind added but not mapped."""
    return _FAULTS.get(kind, ProviderFault.UNKNOWN)


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

    `message` is always one of the fixed strings above — it is what a customer-facing
    fallback is built from, so it never echoes the provider. The original exception is kept
    on `cause` and *is* logged, but only through `app.core.redaction.redact`, which removes
    every configured credential and the prompt before the text reaches a record.
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
        #: Whose fault it is. Carried on the exception so every log site reports the same
        #: answer without re-deriving it — and deliberately **not** placed in `details`,
        #: which is serialised into the HTTP error envelope and is a contract with Node.
        self.fault = fault_for(kind)
        self.provider = provider
        self.model_id = model_id
        self.provider_status = status_code
        #: The underlying exception, for logging only. Never serialised — and never logged
        #: raw: its text goes through `app.core.redaction.redact` first.
        self.cause: Optional[BaseException] = None


@dataclass(frozen=True)
class ProviderModelRef:
    """The descriptor Node sends: which adapter to use, and which model to ask it for.

    Frozen because it is a value handed across a process boundary. Nothing downstream
    should be able to mutate which model a request is running against.
    """

    provider: str
    model_id: str


@dataclass(frozen=True)
class GenerationParams:
    """Sampling parameters for one completion, in the provider layer's own vocabulary.

    A second `GenerationParams` exists in `app.schemas.chat` (a Pydantic model) and that
    duplication is deliberate: the schema one validates a request body at the transport
    boundary, this one is the frozen value the adapters consume. They are not the same type
    because they do not have the same job — the schema model carries validation constraints
    and JSON field names, this one carries no behaviour at all and must stay safe to hand
    across layers mid-request.

    `None` means **do not send the parameter**, not "send the default". A provider that
    receives `temperature=0.0` and one that receives no temperature at all are making
    different requests, and only the caller knows which was intended. Consequently nothing
    here has a default value, and this module holds no table of what a "normal" value is.
    """

    temperature: Optional[float] = None
    top_p: Optional[float] = None
    frequency_penalty: Optional[float] = None
    presence_penalty: Optional[float] = None
    max_tokens: Optional[int] = None


def resolve_temperature(params: Optional[GenerationParams], fallback: float) -> float:
    """The temperature one call should send, decided in exactly one place.

    `temperature` is the only sampling parameter this protocol had before
    `GenerationParams` existed, so it has two possible sources and a precedence that has to
    be stated rather than left to whichever line runs last:

    * the structured parameter, which is where a bot's configuration arrives — plan §6
      classifies `temperature` as a *structured provider parameter*, so when an owner has
      set one, that value is the answer;
    * the legacy argument, which is the fallback and, on the no-configuration path
      (`params is None`), the only source — which is what keeps that path's request
      identical to the one this service made before the feature existed.

    `0.0` is a value, not an absence. Only `None` means "nothing was configured", so an
    explicit `temperature=0.0` survives this function rather than being replaced by the
    fallback. That distinction is the reason this is a function with a docstring instead of
    a `setdefault` somewhere: `setdefault` would get `0.0` right by accident and a future
    refactor to `or` would silently break it.
    """
    if params is not None and params.temperature is not None:
        return params.temperature
    return fallback


class LLMProvider(Protocol):
    """What the registry requires of an adapter.

    A `Protocol` rather than a base class: adapters differ in how they talk to their
    vendor, and the only thing the rest of the service needs is this quartet. There is no
    `@runtime_checkable` here — the registry dispatches by slug, never by `isinstance`,
    and a runtime-checkable protocol with a property member is a footgun.
    """

    #: The stable identifier Node uses in the descriptor. Must match the `slug` column
    #: of the `ai_providers` row, and must never change once shipped.
    slug: str

    #: The generation parameters this adapter's SDK and wire protocol actually accept.
    #:
    #: This is a statement about *this service's own code*, not a copy of the catalog: it
    #: says "this adapter knows how to send top_p", never "this model supports top_p". Node
    #: owns the latter (per-model capability metadata) and filters first; this set is the
    #: second, independent gate, and it is the one that cannot be wrong about what the
    #: vendor SDK accepts.
    #:
    #: A parameter absent from this set is **dropped, not sent** — see
    #: `openai_wire.build_client_kwargs`, which is the one place the intersection happens.
    supported_params: frozenset

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
        params: Optional[GenerationParams] = None,
    ) -> str:
        """Produce a completion, or raise `ProviderError`.

        Implementations must raise `ProviderError` rather than returning an error
        string: Node's failure policy branches on the kind, and a string that merely
        looks like a failure would be indistinguishable from a real answer.

        `params` is **optional with a `None` default** so that every call site written
        before it existed keeps type-checking and behaving identically, and so an adapter
        that declares no `supported_params` can be added without this argument mattering to
        it. `temperature` stays a separate argument for the same reason — it is the one
        parameter this protocol always had, and every existing caller passes it — but it is
        no longer the *only* source: see `resolve_temperature`, which gives the structured
        parameter precedence and falls back to this argument on the no-configuration path.
        """
        ...
