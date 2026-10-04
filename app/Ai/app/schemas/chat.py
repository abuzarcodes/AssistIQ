"""Schemas for Chat pipeline endpoints."""

from typing import List, Dict, Any, Literal, Optional
from pydantic import BaseModel, Field, field_validator
from app.schemas.classifier import IntentPrediction
from app.core.constants import INSUFFICIENT_INFORMATION_SIGNAL


class ModelRef(BaseModel):
    """The catalog model a bot is assigned, as resolved by the Node backend.

    Node owns the catalog: it decides which provider/model pair a bot may use, and it
    builds this descriptor from the bot row — never from client input. This service
    validates `provider` against its adapter registry and passes `model_id` straight to
    that adapter; it holds no catalog and cannot second-guess the choice.

    Both fields are bounded because an unbounded string would reach a vendor SDK.
    """

    provider: str = Field(
        ...,
        min_length=1,
        max_length=64,
        description="Provider slug, matched against the adapter registry",
        example="openrouter",
    )
    model_id: str = Field(
        ...,
        min_length=1,
        max_length=200,
        description="The provider's own model identifier",
        example="openai/gpt-4o-mini",
    )


class GenerationParams(BaseModel):
    """Sampling parameters for one completion.

    Every field is optional and every default is `None`, meaning **do not send this
    parameter at all**. That distinction is the whole point: `temperature: 0.0` and
    "temperature unspecified" are different requests to a provider, and only the pipeline
    knows which one the operator asked for. Nothing here is defaulted to a value, because
    this service holds no default table (plan §8.1).

    The bounds are the operator-facing ones from Node's `BOT_CONFIG_LIMITS`; an out-of-range
    value is a bug upstream rather than something to clamp silently.
    """

    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)
    top_p: Optional[float] = Field(None, gt=0.0, le=1.0)
    frequency_penalty: Optional[float] = Field(None, ge=-2.0, le=2.0)
    presence_penalty: Optional[float] = Field(None, ge=-2.0, le=2.0)
    max_tokens: Optional[int] = Field(None, ge=1, le=8192)


class KnowledgeConfig(BaseModel):
    """How the bot uses its knowledge base (plan §15).

    `strictness` is a three-way preset and deliberately **not** a numeric score threshold:
    the threshold lives in this service's settings, and exposing a number here would make
    every bot's grounding depend on a value the operator cannot calibrate.
    """

    enabled: bool = True
    strictness: Literal["STRICT", "BALANCED", "FLEXIBLE"] = "BALANCED"
    show_sources: bool = False
    top_k: int = Field(3, ge=1, le=20)


class FallbackConfig(BaseModel):
    """Owner-configurable fallback copy (plan §11.6).

    Only the *conversational* dead ends are owner-configurable. Platform-fault messages
    (`MODEL_UNAVAILABLE`, `MODEL_RATE_LIMITED`, `MODEL_ERROR`) are AssistIQ's, are never
    overridable, and are not represented here — an owner must not be able to reword an
    outage into something reassuring.

    The override is applied **in Node**, not here: this service keeps returning its own
    reason-coded copy, and Node substitutes the owner's message for the conversational
    reasons only. So this field is carried for shape agreement and is not read by the
    pipeline.
    """

    message: Optional[str] = Field(None, max_length=500)


class BotConfig(BaseModel):
    """The bot's effective configuration, as resolved by Node (plan §11.1).

    Node merges the stored row over its defaults, so every field below is either present
    with a real value or absent because the operator cleared it. This service applies **no
    defaults of its own** — an absent `personality` emits no personality line, rather than
    emitting the one Node would have defaulted to. Two default tables would be two things
    that can disagree (plan §8.1).
    """

    personality: Optional[
        Literal["PROFESSIONAL", "FRIENDLY", "CONCISE", "WARM", "TECHNICAL", "CASUAL", "CUSTOM"]
    ] = None
    tone: Optional[Literal["NEUTRAL", "FORMAL", "FRIENDLY", "EMPATHETIC", "DIRECT"]] = None
    custom_personality: Optional[str] = Field(None, max_length=500)
    custom_instructions: Optional[str] = Field(None, max_length=4000)
    response_language: Optional[str] = Field(None, max_length=16)
    response_length: Literal["SHORT", "BALANCED", "LONG"] = "BALANCED"
    knowledge: KnowledgeConfig = Field(default_factory=KnowledgeConfig)
    params: GenerationParams = Field(default_factory=GenerationParams)
    fallback: FallbackConfig = Field(default_factory=FallbackConfig)

    @field_validator("custom_instructions")
    @classmethod
    def _reject_sentinel(cls, value: Optional[str]) -> Optional[str]:
        """Refuse owner instructions containing the internal sentinel (plan §7.3).

        Node already rejects this at the API boundary; this is the second gate, at the
        service boundary, and it is the same rule — case-insensitive — so a request that
        Node accepted is never refused here. Two gates rather than one because the failure
        mode is silent: the sentinel is detected by substring match in the model's *reply*,
        so an instruction that taught the model to write it would make the pipeline report
        an unanswerable question that was in fact answered.
        """
        if value and INSUFFICIENT_INFORMATION_SIGNAL in value.upper():
            raise ValueError(
                f"custom_instructions cannot contain {INSUFFICIENT_INFORMATION_SIGNAL}: it is "
                "reserved for the pipeline's own insufficient-information signal."
            )
        return value


class ChatRequest(BaseModel):
    """Request payload for the main chat endpoint.

    Defined after `BotConfig` rather than beside `ModelRef` so that every field's annotation
    resolves at class-creation time. A forward reference would work, but it would defer the
    failure to the first request instead of the first import.
    """

    bot_id: str = Field(..., description="Unique ID of tenant bot", example="demo_bot_001")
    message: str = Field(..., description="User message/question", example="Can I get my money back?")
    model: Optional[ModelRef] = Field(
        default=None,
        description=(
            "Optional catalog model for this bot. Absent means the request runs on the "
            "service's environment-configured default — the behaviour of every request "
            "before the model catalog existed."
        ),
    )
    fallback_model: Optional[ModelRef] = Field(
        default=None,
        description=(
            "Optional second catalog model, used only if `model` fails in a failover-eligible "
            "way. Node resolves both from its own catalog and sends both descriptors; this "
            "service never chooses a model. Absent means the failover path is inert, which is "
            "the default."
        ),
    )
    config: Optional[BotConfig] = Field(
        default=None,
        description=(
            "The bot's effective configuration, resolved by Node. **Absent means legacy "
            "behaviour** — the pre-feature pipeline — and not 'the defaults'. Node always "
            "sends a complete configuration, so a missing one is a caller that predates the "
            "feature, and it must behave exactly as it did then."
        ),
    )


class SourceRef(BaseModel):
    """A knowledge chunk the answer was drawn from, as an identifier only.

    **Identifiers, never content and never scores.** Node resolves the display label from its
    own mirrored `KnowledgeSource` rows, so the metadata authority stays in Node, and the
    client learns *which document* an answer came from — never *how well* it scored. A
    similarity score in a customer-facing payload is the deferred "why did the bot answer
    this?" diagnostics feature, and this field is deliberately not a foothold for it.
    """

    chunk_id: str = Field(..., description="The knowledge chunk id")
    source_id: Optional[str] = Field(default=None, description="The source document id")
    topic: Optional[str] = Field(default=None, description="The chunk's topic label")
    page_number: Optional[int] = Field(default=None, description="Page within the source document")


class IntentInfo(BaseModel):
    """Intent metadata in chat response."""
    predicted: str = Field(..., description="Predicted intent")
    confidence: float = Field(..., description="Confidence score")


class RetrievalInfo(BaseModel):
    """Retrieval metadata in chat response.

    The last two fields are **server-side only** and are excluded from serialisation, so they
    can never appear in an HTTP body however a caller constructs this object. They exist
    because the strictness decision is worth a log line — "why did this bot refuse?" is
    answered by *which* gate fired — and a debugger that reads the pipeline in-process should
    be able to see it. The browser must not: `strictness_applied` names an internal preset and
    `confidence_gate_passed` a score comparison, and together they are exactly the retrieval
    diagnostics deliberately kept out of the customer payload (see `SourceRef`, which carries
    identifiers for the same reason).
    """
    used_topic_filter: bool = Field(..., description="Whether a topic filter was applied based on intent")
    top_score: float = Field(..., description="Highest similarity score among retrieved chunks")
    documents_found: int = Field(..., description="Number of relevant documents found")
    strictness_applied: Optional[str] = Field(
        default=None,
        exclude=True,
        description="Internal: the strictness preset the gate was evaluated against",
    )
    confidence_gate_passed: Optional[bool] = Field(
        default=None,
        exclude=True,
        description="Internal: whether the retrieval confidence gate admitted the results",
    )


class ChatResponse(BaseModel):
    """Response payload for the main chat endpoint."""

    status: str = Field(..., description="Response status ('success' or 'error')")
    response: str = Field(..., description="Generated natural language response or fallback message")
    fallback_required: bool = Field(..., description="Whether the system had to fallback")
    
    intent: Optional[IntentInfo] = Field(default=None, description="Intent classification metadata")
    retrieval: Optional[RetrievalInfo] = Field(default=None, description="RAG retrieval metadata")
    reason: Optional[str] = Field(default=None, description="Reason code if fallback occurred")
    sources: Optional[List[SourceRef]] = Field(
        default=None,
        description=(
            "Knowledge chunks the answer drew on. Populated only when the bot's "
            "configuration asks for them (`knowledge.show_sources`) **and** the turn "
            "produced an answer; `null` otherwise, including on every request that carries "
            "no configuration."
        ),
    )
    model_used: Optional[str] = Field(
        default=None,
        description=(
            "The model that produced this answer, as `provider:model_id` — the primary "
            "unless a failover served the turn. **Node-only.** It is returned for Node to "
            "log and to report in `effective`; it is never forwarded into a client-facing "
            "payload, because which vendor's model answered is platform information."
        ),
    )
    failover_used: bool = Field(
        default=False,
        description="Whether the fallback model served this turn. Node-only, like `model_used`.",
    )
    human_requested: bool = Field(
        default=False,
        description=(
            "Whether the customer explicitly asked to speak to a person. This is a "
            "**detection**, not a decision: Node applies `humanRequestBehavior` to it, which "
            "is why the field carries no status and no message."
        ),
    )


# Testing/Debug Schemas

class PipelineDebugResponse(BaseModel):
    """Detailed response exposing all pipeline steps for debugging/demonstration."""

    input: Dict[str, str] = Field(..., description="Original input")
    classification: Dict[str, Any] = Field(..., description="Intent classification results")
    retrieval_strategy: Dict[str, Any] = Field(..., description="Strategy used for retrieval")
    retrieval_results: List[Dict[str, Any]] = Field(..., description="Raw retrieved chunks")
    retrieval_confidence: Dict[str, Any] = Field(..., description="Evaluation of retrieval strength")
    generation: Optional[Dict[str, Any]] = Field(default=None, description="LLM generation metadata")
    final_result: Dict[str, Any] = Field(..., description="Final response and fallback status")
