"""Deterministic Hybrid Chat Pipeline Service."""

import asyncio
import time
from typing import Dict, Any, List, Optional, Tuple

from app.core.config import settings
from app.schemas.chat import BotConfig, SourceRef
from app.services.classifier_service import get_classifier_service
from app.services.escalation_service import detect_human_request
from app.services.rag_service import get_rag_service
from app.services.llm_service import get_llm_service
from app.services.fallback_service import get_fallback_service
from app.providers import GenerationParams, ProviderError, ProviderErrorKind, ProviderModelRef
from app.prompts.support_prompt import build_system_prompt, build_user_prompt
from app.core.constants import (
    FALLBACK_REASON_LOW_CLASSIFICATION_CONFIDENCE,
    FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE,
    FALLBACK_REASON_LOW_RETRIEVAL_CONFIDENCE,
    FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION,
    FALLBACK_REASON_MODEL_UNAVAILABLE,
    FALLBACK_REASON_MODEL_RATE_LIMITED,
    FALLBACK_REASON_MODEL_ERROR,
    INSUFFICIENT_INFORMATION_SIGNAL,
    INTENT_GENERAL_SUPPORT
)
from app.core.logging import logger, format_log_context
from app.core.redaction import redact

#: The `top_k` used when no configuration was sent — the value this pipeline hard-coded
#: before retrieval depth became configurable (`chat_service.py`'s original `top_k=3`). It
#: lives here rather than in a defaults table because it is not a *default*: it is what a
#: request that predates the feature must keep doing, and the only other place that number
#: is allowed to exist is Node's `BOT_CONFIG_DEFAULTS.retrievalTopK`.
_LEGACY_TOP_K = 3

#: The temperature used when no configuration was sent, matching the original hard-coded
#: `temperature=0.0  # Deterministic` in the generation step.
_LEGACY_TEMPERATURE = 0.0

#: How a typed provider failure is reported to the customer (Checkpoint 6).
#:
#: The three *configuration* kinds collapse onto `MODEL_UNAVAILABLE`, which is the same code
#: Node produces for every condition it can detect before calling us — a customer does not
#: need to distinguish "no adapter is deployed" from "the key was rejected" from "the model
#: was switched off", and saying which would leak platform internals into their thread. The
#: two operational kinds map to `MODEL_ERROR`, which tells the operator the fault was not
#: theirs to configure.
#:
#: `UNKNOWN` maps to `MODEL_ERROR` rather than `MODEL_UNAVAILABLE`: an unclassifiable
#: exception is an operational fault, and reporting it as a configuration problem would send
#: whoever reads the log looking in the wrong place.
_PROVIDER_FAILURE_REASONS: Dict[ProviderErrorKind, str] = {
    ProviderErrorKind.UNKNOWN_PROVIDER: FALLBACK_REASON_MODEL_UNAVAILABLE,
    ProviderErrorKind.NOT_CONFIGURED: FALLBACK_REASON_MODEL_UNAVAILABLE,
    ProviderErrorKind.AUTH: FALLBACK_REASON_MODEL_UNAVAILABLE,
    ProviderErrorKind.BAD_REQUEST: FALLBACK_REASON_MODEL_UNAVAILABLE,
    ProviderErrorKind.RATE_LIMIT: FALLBACK_REASON_MODEL_RATE_LIMITED,
    ProviderErrorKind.UPSTREAM: FALLBACK_REASON_MODEL_ERROR,
    ProviderErrorKind.TIMEOUT: FALLBACK_REASON_MODEL_ERROR,
    ProviderErrorKind.UNKNOWN: FALLBACK_REASON_MODEL_ERROR,
}

#: Failure kinds that always earn the fallback a chance (plan §13.3): transient or
#: provider-side conditions, where a different vendor's model may well succeed — and where
#: retrying the *same* model later is the only other sane response, which this pipeline
#: cannot offer.
_FAILOVER_ELIGIBLE: frozenset = frozenset({
    ProviderErrorKind.RATE_LIMIT,
    ProviderErrorKind.UPSTREAM,
    ProviderErrorKind.TIMEOUT,
    ProviderErrorKind.UNKNOWN,
})

#: Failure kinds where the fallback is worth a chance **only on a different provider slug**
#: (plan §13.3). Both are configuration faults on our side, but the configuration that
#: failed belongs to the primary — the fallback may hold an entirely independent credential.
#: Failing over to the *same* provider is guaranteed to fail identically, so it is not
#: attempted: it costs a call and a wait to learn nothing.
_FAILOVER_IF_DIFFERENT_PROVIDER: frozenset = frozenset({
    ProviderErrorKind.AUTH,
    ProviderErrorKind.NOT_CONFIGURED,
})


def reason_for_provider_error(err: ProviderError) -> str:
    """Map a typed provider failure onto the reason vocabulary Node shares.

    Falls back to `MODEL_ERROR` for a kind added to the enum but not to the table above:
    guessing `MODEL_UNAVAILABLE` would be an affirmative claim about the platform's
    configuration that this code cannot make.
    """
    return _PROVIDER_FAILURE_REASONS.get(err.kind, FALLBACK_REASON_MODEL_ERROR)


def failover_eligible(
    kind: ProviderErrorKind,
    model: Optional[ProviderModelRef],
    fallback_model: Optional[ProviderModelRef],
) -> bool:
    """Whether `kind` on `model` earns one retry on `fallback_model` (plan §13.3).

    The eligibility table itself is `_FAILOVER_ELIGIBLE` / `_FAILOVER_IF_DIFFERENT_PROVIDER`
    above; this function is the two conditions that surround it.

    No fallback configured means the whole path is inert — not "ineligible this time", but
    "there is nothing to retry on", which is the default state of every bot that has not been
    given a second model.

    When the primary is the service's *environment*-configured model (`model is None`) its
    provider slug is not knowable here, so the "different provider" condition cannot be
    proven and the retry is not attempted. The alternative — assuming it differs — would
    spend a provider call on a comparison this service is unable to make.
    """
    if fallback_model is None:
        return False
    if kind in _FAILOVER_ELIGIBLE:
        return True
    if kind in _FAILOVER_IF_DIFFERENT_PROVIDER:
        if model is None:
            return False
        return model.provider != fallback_model.provider
    return False


def _refusal_reason(
    strictness: Optional[str], rag_result: Dict[str, Any]
) -> Optional[str]:
    """Which knowledge gate refuses this turn, or `None` to go on and generate (§15.2).

    The three presets, in one place:

    * `STRICT` — results must be non-empty **and** clear the confidence threshold; failing
      either is a refusal, because an owner who chose STRICT asked for answers this bot can
      stand behind rather than answers it can merely produce.
    * `BALANCED` — results must be non-empty. No score gate, which is exactly the behaviour
      this pipeline had before strictness was configurable.
    * `FLEXIBLE` — no gate at all: it generates even from zero results, because that preset
      licenses general knowledge. This is the only preset for which "nothing was retrieved"
      is a prompt condition rather than a refusal.

    `strictness=None` (no configuration was sent) is `BALANCED`, and deliberately by
    *construction* rather than by a branch: neither the FLEXIBLE nor the STRICT clause
    matches, so the function falls through to the same two lines the feature never changed.
    That is what keeps the unconfigured path a real statement about backward compatibility.
    """
    if strictness == "FLEXIBLE":
        return None
    if not rag_result["results"]:
        return FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE
    if strictness == "STRICT" and not rag_result["is_confident"]:
        return FALLBACK_REASON_LOW_RETRIEVAL_CONFIDENCE
    return None


def _confidence_gate_passed(strictness: Optional[str], rag_result: Dict[str, Any]) -> bool:
    """Whether the knowledge gate admitted this turn — the log-only twin of `_refusal_reason`.

    Derived from the refusal instead of re-deriving the three conditions, so the two can never
    disagree: there is one gate in this service and one function that evaluates it.

    It reports the **whole** gate rather than the score comparison alone. A turn refused for
    having retrieved nothing has `top_score` 0.0 and would "fail" the comparison anyway, but
    defining the flag that way would be an accident of arithmetic rather than a statement
    about what happened; this reads as what it is — the gate did not pass.
    """
    return _refusal_reason(strictness, rag_result) is None


def _no_retrieval_result() -> Dict[str, Any]:
    """The retrieval result for a turn that deliberately performed no retrieval (§15.1).

    Not a mock and not an empty search: `knowledge.enabled = false` means no embedding call
    and no vector query were made, and this is the record of that decision. Every field is the
    honest consequence — nothing was filtered, nothing scored, nothing found — so the
    response's `retrieval` block stays shaped as Node's schema requires without claiming a
    search happened.

    Returned as a fresh dict per call: this service is a process-wide singleton serving
    concurrent requests, and a shared mutable result would be one more thing two requests
    could write into each other's turn.
    """
    return {
        "results": [],
        "top_score": 0.0,
        "is_confident": False,
        "threshold": settings.RETRIEVAL_CONFIDENCE_THRESHOLD,
        "used_topic_filter": False,
    }


def _blank_to_none(value: Optional[str]) -> Optional[str]:
    """Normalise the ingestion path's `""`-means-absent convention to `None`.

    `add_documents` writes `chunk.get("source_id", "")`, and an FAQ entry has no source row,
    so `""` reaches here routinely. Passing it through would give Node an empty filename to
    render — an empty label where it would otherwise have drawn "FAQ entry".
    """
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _sources_for(rag_result: Dict[str, Any]) -> List[SourceRef]:
    """Citations for the chunks this answer was grounded in (plan §15.3).

    **Identifiers only.** `chunk["score"]` is deliberately not read here, and neither is
    `chunk["content"]`: a similarity score in a customer-facing payload is the deferred
    retrieval-diagnostics feature, and re-sending the passage would leak the knowledge base
    into the thread it was retrieved for.

    `page_number` comes from chunk metadata rather than a column because there is no column —
    it is written at ingestion by whichever extractor knows where the page boundaries fell,
    and FAQ chunks carry no such key, so their `page_number` is `None`.
    """
    sources: List[SourceRef] = []
    for chunk in rag_result["results"]:
        metadata = chunk.get("metadata") or {}
        sources.append(
            SourceRef(
                chunk_id=chunk["id"],
                source_id=_blank_to_none(chunk.get("source_id")),
                topic=_blank_to_none(chunk.get("topic")),
                page_number=metadata.get("page_number"),
            )
        )
    return sources


def _monotonic() -> float:
    """The clock the generation budget is measured against.

    A module-level indirection over `time.monotonic` so tests can pin the budget arithmetic
    (plan §13.5 requires that invariant to be asserted rather than merely documented) without
    sleeping for real seconds. Monotonic rather than wall-clock: the budget answers "how long
    has this taken", and a clock adjustment mid-request must not be able to extend or void it.
    """
    return time.monotonic()


def _describe_model(ref: Optional[ProviderModelRef]) -> Optional[str]:
    """`provider:model_id` for a resolved descriptor, or `None` when none was named.

    `None` is the honest answer for the environment-driven path. Node reports model state
    from its own catalog, and reporting this service's `LLM_PROVIDER`/`LLM_MODEL` here would
    present platform configuration as though it were the bot's assignment — a distinction
    Node's `effective` block already draws by absence.
    """
    return None if ref is None else f"{ref.provider}:{ref.model_id}"


def _budget_timeout_error(ref: ProviderModelRef, cause: BaseException) -> ProviderError:
    """A `TIMEOUT` for an attempt this service itself cut short.

    The adapter would not have raised this: the call was still in flight when the generation
    budget ran out, so nothing inside the SDK knows it was abandoned. Reported as `TIMEOUT`
    rather than as an unknown failure because that is precisely what happened, and it puts the
    attempt into the same vocabulary the adapters' own timeouts use.
    """
    err = ProviderError(
        ProviderErrorKind.TIMEOUT,
        provider=ref.provider,
        model_id=ref.model_id,
    )
    err.cause = cause
    return err


def _most_severe_failure(primary: ProviderError, fallback: ProviderError) -> ProviderError:
    """Which of two failed attempts the response reports (plan §13.4.1).

    When exactly one of them is a **configuration** fault, that one is reported: an
    actionable fault — a rejected key, a model id the provider does not recognise, an adapter
    never deployed — must never be masked by a transient one from the other attempt. The
    severity is not cosmetic; `_provider_failure_response` logs configuration faults at ERROR
    and everything else at WARNING, so choosing the wrong one would also choose the wrong
    severity, and the operator reading the log would look in the wrong place.

    Otherwise the fallback's error is reported. Both failures are then equally actionable (or
    equally not), and the fallback is the attempt the turn ended on, so it describes the state
    the customer is actually in. Both are on `debug_info["failover"]` either way.
    """
    primary_is_config = reason_for_provider_error(primary) == FALLBACK_REASON_MODEL_UNAVAILABLE
    fallback_is_config = reason_for_provider_error(fallback) == FALLBACK_REASON_MODEL_UNAVAILABLE
    if primary_is_config and not fallback_is_config:
        return primary
    if fallback_is_config and not primary_is_config:
        return fallback
    return fallback


def _resolve_generation_params(
    config: Optional[BotConfig],
) -> tuple[Optional[GenerationParams], float]:
    """Turn the request's configuration into what the provider layer needs.

    Returns `(params, temperature)`. Both carry the configured temperature when there is
    one, and that duplication is intentional rather than an oversight: plan §6 classifies
    `temperature` as a *structured provider parameter*, so it belongs in `params`, while
    `generate`'s `temperature` argument is the protocol's original channel and every caller
    before this feature passes it. `providers.base.resolve_temperature` states which wins
    (the structured value) and what happens when only one is present, so the two routes can
    never disagree silently — they are the same number here by construction.

    An absent configuration yields `(None, 0.0)` — no `params` object at all, so the model
    path forwards exactly the arguments it forwarded before this feature existed, and the
    legacy argument stands alone as it always did.

    A configuration whose parameters are all unset yields a `GenerationParams` whose every
    field is `None`, which the adapters intersect down to nothing. That is the same request
    as `(None, ...)` by construction; the object exists only so a caller can see that the
    configuration was read.
    """
    if config is None:
        return None, _LEGACY_TEMPERATURE

    supplied = config.params
    temperature = _LEGACY_TEMPERATURE if supplied.temperature is None else supplied.temperature
    params = GenerationParams(
        temperature=supplied.temperature,
        top_p=supplied.top_p,
        frequency_penalty=supplied.frequency_penalty,
        presence_penalty=supplied.presence_penalty,
        max_tokens=supplied.max_tokens,
    )
    return params, temperature


class ChatService:
    """Coordinates the deterministic hybrid AI pipeline."""

    def __init__(self):
        self.classifier = get_classifier_service()
        self.rag = get_rag_service()
        self.llm = get_llm_service()
        self.fallback = get_fallback_service()

    async def process_chat(
        self,
        bot_id: str,
        message: str,
        model: Optional[ProviderModelRef] = None,
        fallback_model: Optional[ProviderModelRef] = None,
        config: Optional[BotConfig] = None,
    ) -> Dict[str, Any]:
        """Execute the full Classify -> Route -> Retrieve -> Validate -> Generate pipeline.

        `model` is the catalog model Node resolved for this bot, or `None` to use the
        service's environment-configured default. It is threaded through as a **local**,
        never stored on `self`: this service is a process-wide singleton, and FastAPI
        serves requests concurrently, so an attribute would let one request's model leak
        into another's generation across the awaits below. `fallback_model` is the same, and
        is consumed only by `_generate_with_failover`.

        `config` is the bot's effective configuration, or `None` for a caller that predates
        the feature. **`None` is not "the defaults"** — it selects the pre-feature prompt,
        the pre-feature retrieval depth and the pre-feature temperature, which is what makes
        the no-config regression test a real statement about backward compatibility rather
        than a comparison of two identical code paths. It also leaves every field this
        checkpoint added at its default: no sources, no failover report, no human-request
        detection — a caller with no configuration has no `humanRequestBehavior` for the
        detection to serve.
        """

        debug_info = {
            "input": {"message": message, "bot_id": bot_id}
        }

        # 1. Classify Intent
        #
        # Classification runs even when knowledge is switched off. It is a local TF-IDF
        # model (`classifier_service`), so it costs no network call and no embedding, and
        # `intent` is part of the response contract regardless of which knowledge mode the
        # bot is in. Skipping it would blank a field Node reads to keep the pipeline's cheap
        # work and its expensive work on separate switches.
        classification_result = self.classifier.classify(message)
        debug_info["classification"] = classification_result

        intent = classification_result["intent"]

        # 2. Route & Retrieve
        #
        # `config is None` means the pre-feature request, which always retrieved — so the
        # disabled branch is reachable only from an explicit `knowledge.enabled = false`.
        knowledge_enabled = config is None or config.knowledge.enabled

        if knowledge_enabled:
            # If confidence is too low, or the intent is the general bucket, no topic filter
            # is applied and the search runs against the bot's whole knowledge base.
            topic_filter = intent if classification_result["is_confident"] and intent != INTENT_GENERAL_SUPPORT else None

            debug_info["retrieval_strategy"] = {
                "used_topic_filter": topic_filter is not None,
                "topic": topic_filter
            }

            rag_result = await self.rag.search(
                query=message,
                bot_id=bot_id,
                top_k=config.knowledge.top_k if config is not None else _LEGACY_TOP_K,
                topic_filter=topic_filter
            )

            debug_info["retrieval_results"] = rag_result["results"]
            debug_info["retrieval_confidence"] = {
                "top_score": rag_result["top_score"],
                "is_confident": rag_result["is_confident"]
            }
        else:
            # No embedding call and no vector query, because that is what the setting means
            # — not "search returned nothing", which would be a different fact.
            debug_info["retrieval_strategy"] = {
                "used_topic_filter": False,
                "topic": None,
                "skipped": "KNOWLEDGE_DISABLED",
            }
            debug_info["retrieval_results"] = []
            rag_result = _no_retrieval_result()

        strictness = config.knowledge.strictness if config is not None else None

        # 3. Validate Retrieval (plan §15.2)
        refusal = _refusal_reason(strictness, rag_result) if knowledge_enabled else None
        confidence_gate_passed = (
            _confidence_gate_passed(strictness, rag_result) if knowledge_enabled else None
        )

        human_requested = config is not None and detect_human_request(
            message, config.response_language
        )

        if refusal is not None:
            logger.info(
                "Knowledge gate refused the turn for bot %s: %s",
                bot_id,
                refusal,
                extra=format_log_context(
                    operation="knowledge_gate",
                    bot_id=bot_id,
                    reason=refusal,
                    strictness=strictness,
                    top_score=rag_result["top_score"],
                    threshold=rag_result.get("threshold"),
                    documents_found=len(rag_result["results"]),
                ),
            )
            fallback_res = self.fallback.get_fallback(refusal, bot_id)
            return self._build_response(
                fallback_res,
                classification_result,
                rag_result,
                debug_info,
                strictness_applied=strictness,
                confidence_gate_passed=confidence_gate_passed,
                human_requested=human_requested,
            )

        # 4. Generate
        #
        # The context block is empty when the bot has no knowledge base. `build_user_prompt`
        # is still the one builder: the *mode* lives in the system prompt's Block 2, which is
        # where plan §7 puts it, and a second user-prompt variant would be a prompt rule
        # invented outside the documented hierarchy.
        context_str = "\n\n".join([f"[{res['topic']}] {res['content']}" for res in rag_result["results"]])
        # `build_system_prompt(None)` returns the legacy prompt verbatim, so there is one call
        # site and no branch: the difference between configured and unconfigured lives in the
        # prompt builder, where it can be snapshot-tested.
        system_msg = build_system_prompt(config)
        user_msg = build_user_prompt(message, context_str)

        generation_params, temperature = _resolve_generation_params(config)

        debug_info["generation"] = {
            "system_prompt": system_msg,
            "user_prompt": user_msg
        }

        generate_call: Dict[str, Any] = {
            "prompt": user_msg,
            "system_message": system_msg,
            "temperature": temperature,
            "model": model,
        }
        # `params` is offered only when the configuration actually specified something. That
        # is not an optimisation: a request with no configuration must make *the same call*
        # this pipeline made before the feature existed, argument list included. Passing
        # `params=None` would produce the same answer but a different call, and "the legacy
        # path is untouched" is a claim better made structurally than by inspection.
        if generation_params is not None:
            generate_call["params"] = generation_params

        try:
            llm_response, model_used, failover_used = await self._generate_with_failover(
                generate_call, model, fallback_model, bot_id, debug_info
            )
        except ProviderError as err:
            # A provider failure is an expected, reportable state, not a server error. It
            # becomes a reason-coded fallback here so Node escalates the conversation
            # exactly as it does for a conversational dead end.
            #
            # Catching it in the pipeline rather than in the route is what makes that
            # structural: `api/routes/chat.py`'s `except Exception` -> 500 is unreachable
            # for a provider failure, because one can no longer escape this frame. `err` is
            # the outcome of the whole failover attempt, not necessarily the primary's.
            return self._provider_failure_response(
                err, bot_id, classification_result, rag_result, debug_info,
                human_requested=human_requested,
            )

        debug_info["generation"]["raw_response"] = llm_response

        # 5. Check LLM Fallback Signal
        #
        # Skipped when knowledge is off (plan §15.1): the requirement was dropped from the
        # prompt in that mode, so the token is not the protocol any more — and a
        # general-knowledge bot that refused because a model wrote an internal code word
        # would be refusing for a reason the owner switched off.
        if knowledge_enabled and INSUFFICIENT_INFORMATION_SIGNAL in llm_response:
            fallback_res = self.fallback.get_fallback(FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION, bot_id)
            return self._build_response(
                fallback_res,
                classification_result,
                rag_result,
                debug_info,
                strictness_applied=strictness,
                confidence_gate_passed=confidence_gate_passed,
                model_used=model_used,
                failover_used=failover_used,
                human_requested=human_requested,
            )

        # Success
        success_res = {
            "fallback_required": False,
            "response": llm_response,
            "reason": None
        }
        # Sources are for answers only. A refusal citing the passages that failed to answer
        # the question would be worse than saying nothing, which is why every fallback above
        # leaves them `None` — including the double-failure path, where no generation
        # succeeded at all.
        sources = (
            _sources_for(rag_result)
            if config is not None and config.knowledge.show_sources
            else None
        )
        return self._build_response(
            success_res,
            classification_result,
            rag_result,
            debug_info,
            sources=sources,
            strictness_applied=strictness,
            confidence_gate_passed=confidence_gate_passed,
            model_used=model_used,
            failover_used=failover_used,
            human_requested=human_requested,
        )

    async def _generate_with_failover(
        self,
        generate_call: Dict[str, Any],
        model: Optional[ProviderModelRef],
        fallback_model: Optional[ProviderModelRef],
        bot_id: str,
        debug_info: Dict[str, Any],
    ) -> Tuple[str, Optional[str], bool]:
        """Generate, retrying **once** on the fallback model when the failure earns it.

        Returns `(reply, model_used, failover_used)`, or raises the `ProviderError` the
        caller should report — which is not necessarily the primary's; see
        `_most_severe_failure`.

        Only the generation step is repeated (plan §13.4.2): classification and retrieval are
        not, because neither depends on which model answers, and re-embedding the query would
        double the cost of the failure path. The fallback receives **the same**
        `GenerationParams` (plan §13.4.3), filtered by its own adapter's `supported_params`
        inside `build_client_kwargs` — so a Gemini fallback silently drops penalties an
        OpenAI primary used, without this function knowing which parameters those are.

        The retry is a single `if`, not a loop, and there is no counter to get wrong: after
        the fallback fails, the ordinary reason-coded response runs (plan §13.4.1).

        **The budget** (plan §13.5). The clock starts before the primary attempt, and what
        remains of `GENERATION_BUDGET_SECONDS` caps the fallback with `asyncio.wait_for` —
        the arithmetic of `min(adapter_timeout, budget - elapsed)`, where the adapter's own
        `request_timeout` still binds inside and the wait is the outer bound. If less than
        `FAILOVER_MIN_REMAINING_SECONDS` is left, the attempt is **skipped**: a call started
        with two seconds left is a call that would be killed mid-flight, producing exactly
        the AI-service-unavailable error this budget exists to prevent, while still being
        paid for. Skipping reports the primary's failure immediately and honestly.
        """
        started = _monotonic()

        try:
            reply = await self.llm.generate(**generate_call)
        except ProviderError as primary_err:
            if not failover_eligible(primary_err.kind, model, fallback_model):
                debug_info["failover"] = {
                    "attempted": False,
                    "skipped": "INELIGIBLE",
                    "primary_kind": primary_err.kind.value,
                }
                raise

            elapsed = _monotonic() - started
            remaining = settings.GENERATION_BUDGET_SECONDS - elapsed
            if remaining < settings.FAILOVER_MIN_REMAINING_SECONDS:
                debug_info["failover"] = {
                    "attempted": False,
                    "skipped": "BUDGET_EXHAUSTED",
                    "primary_kind": primary_err.kind.value,
                    "elapsed_seconds": elapsed,
                    "remaining_seconds": remaining,
                }
                logger.warning(
                    "Skipping model failover for bot %s: %.2fs of the %.1fs generation "
                    "budget remained, below the %.1fs floor.",
                    bot_id,
                    remaining,
                    settings.GENERATION_BUDGET_SECONDS,
                    settings.FAILOVER_MIN_REMAINING_SECONDS,
                    extra=format_log_context(
                        operation="chat_failover_skipped",
                        bot_id=bot_id,
                        reason="BUDGET_EXHAUSTED",
                        primary_kind=primary_err.kind.value,
                        elapsed_ms=round(elapsed * 1000),
                        remaining_seconds=round(remaining, 3),
                    ),
                )
                raise

            return await self._attempt_fallback(
                generate_call,
                fallback_model,
                primary_err,
                bot_id,
                debug_info,
                started,
                remaining,
            )

        return reply, _describe_model(model), False

    async def _attempt_fallback(
        self,
        generate_call: Dict[str, Any],
        fallback_model: ProviderModelRef,
        primary_err: ProviderError,
        bot_id: str,
        debug_info: Dict[str, Any],
        started: float,
        remaining: float,
    ) -> Tuple[str, Optional[str], bool]:
        """Run the one fallback attempt, bounded by `remaining` seconds.

        Split out of `_generate_with_failover` only so the success path and the two-failure
        path are each readable end to end; it is not called from anywhere else.
        """
        fallback_call = dict(generate_call, model=fallback_model)
        try:
            reply = await asyncio.wait_for(
                self.llm.generate(**fallback_call), timeout=remaining
            )
        except asyncio.TimeoutError as exc:
            fallback_err: ProviderError = _budget_timeout_error(fallback_model, exc)
        except ProviderError as exc:
            fallback_err = exc
        else:
            # A successful failover is a normal answer (plan §13.4.6): `fallback_required`
            # is untouched, and the customer sees nothing different.
            elapsed = _monotonic() - started
            debug_info["failover"] = {
                "attempted": True,
                "succeeded": True,
                "primary_kind": primary_err.kind.value,
                "model_used": _describe_model(fallback_model),
                "elapsed_seconds": elapsed,
            }
            logger.warning(
                "Model failover succeeded for bot %s: %s -> %s after %s.",
                bot_id,
                _describe_model(generate_call.get("model")),
                _describe_model(fallback_model),
                primary_err.kind.value,
                extra=format_log_context(
                    operation="chat_failover",
                    bot_id=bot_id,
                    outcome="succeeded",
                    primary_provider=(
                        generate_call["model"].provider
                        if generate_call.get("model") is not None
                        else None
                    ),
                    primary_model_id=(
                        generate_call["model"].model_id
                        if generate_call.get("model") is not None
                        else None
                    ),
                    fallback_provider=fallback_model.provider,
                    fallback_model_id=fallback_model.model_id,
                    primary_kind=primary_err.kind.value,
                    primary_fault=primary_err.fault.value,
                    elapsed_ms=round(elapsed * 1000),
                ),
            )
            return reply, _describe_model(fallback_model), True

        elapsed = _monotonic() - started
        debug_info["failover"] = {
            "attempted": True,
            "succeeded": False,
            "primary_kind": primary_err.kind.value,
            "fallback_kind": fallback_err.kind.value,
            "elapsed_seconds": elapsed,
        }
        reported = _most_severe_failure(primary_err, fallback_err)
        logger.warning(
            "Model failover failed for bot %s: primary %s, fallback %s. Reporting %s.",
            bot_id,
            primary_err.kind.value,
            fallback_err.kind.value,
            reported.kind.value,
            extra=format_log_context(
                operation="chat_failover",
                bot_id=bot_id,
                outcome="failed",
                primary_kind=primary_err.kind.value,
                primary_fault=primary_err.fault.value,
                fallback_provider=fallback_model.provider,
                fallback_model_id=fallback_model.model_id,
                fallback_kind=fallback_err.kind.value,
                fallback_fault=fallback_err.fault.value,
                reported_kind=reported.kind.value,
                reported_reason=reason_for_provider_error(reported),
                elapsed_ms=round(elapsed * 1000),
            ),
        )
        raise reported

    def _provider_failure_response(
        self,
        err: ProviderError,
        bot_id: str,
        classification: Dict[str, Any],
        rag: Dict[str, Any],
        debug_info: Dict[str, Any],
        *,
        human_requested: bool = False,
    ) -> Dict[str, Any]:
        """Turn a typed provider failure into an ordinary fallback pipeline result.

        The response shape is identical to every other fallback, which is the point: Node
        needs no new branch, and `fallback_required` alone drives the escalation.

        `model_used` and `failover_used` stay at their defaults here. Nothing generated, so
        there is no model that "produced this answer", and reporting the fallback as *used*
        would tell Node a fallback served the turn while the customer received an error —
        for which Node's own UI would then say "your primary is down; the fallback is
        serving". The attempt is recorded on `debug_info["failover"]`, server-side, where the
        operator can see it and the client cannot.

        Logged with everything needed to tell a platform misconfiguration from a provider
        outage — the provider, the model id, the failure kind, and whether the fault is ours
        or theirs — none of which appear in the message or the response body. This is the
        second line for a provider failure: the adapter already logged one with the HTTP
        status and the provider's own words (redacted). This one adds the bot and the reason
        code Node will see, at the same severity, so the two can be read together.

        The provider's exception *is* rendered here, through `redact`, which removes every
        configured credential and the prompt before the text reaches the record.
        """
        reason = reason_for_provider_error(err)

        # The prompt lives on `debug_info` for this request; reusing it here keeps the
        # redaction honest without threading two more parameters through the pipeline.
        generation = debug_info.get("generation") or {}
        context = format_log_context(
            operation="chat_provider_failure",
            bot_id=bot_id,
            provider=err.provider,
            model_id=err.model_id,
            reason=reason,
            kind=err.kind.value,
            fault=err.fault.value,
            provider_status=err.provider_status,
            provider_message=(
                redact(
                    str(err.cause),
                    redact_also=(generation.get("user_prompt", ""), generation.get("system_prompt", "")),
                )
                if err.cause is not None
                else None
            ),
        )

        if reason == FALLBACK_REASON_MODEL_UNAVAILABLE:
            # A configuration fault demanding action: no adapter, no credential, a rejected
            # credential, or a model id the provider does not recognise.
            logger.error("Model unavailable for bot %s: %s", bot_id, reason, extra=context)
        else:
            # Transient: a throttle or an upstream fault. Worth knowing, not worth waking up for.
            logger.warning("Model call failed for bot %s: %s", bot_id, reason, extra=context)

        debug_info["provider_failure"] = {
            "reason": reason,
            "kind": err.kind.value,
            "provider": err.provider,
            "model_id": err.model_id,
            "provider_status": err.provider_status,
        }

        fallback_res = self.fallback.get_fallback(reason, bot_id)
        return self._build_response(
            fallback_res,
            classification,
            rag,
            debug_info,
            human_requested=human_requested,
        )

    def _build_response(
        self,
        base_res: Dict[str, Any],
        classification: Dict[str, Any],
        rag: Dict[str, Any],
        debug_info: Dict[str, Any],
        *,
        sources: Optional[List[SourceRef]] = None,
        strictness_applied: Optional[str] = None,
        confidence_gate_passed: Optional[bool] = None,
        model_used: Optional[str] = None,
        failover_used: bool = False,
        human_requested: bool = False,
    ) -> Dict[str, Any]:
        """Helper to assemble the final ChatResponse payload.

        Keyword-only past `debug_info`, so a fifth positional argument cannot silently become
        the wrong field as this grows.

        `sources` defaults to `None`, which is the correct value for every fallback and for
        every bot that has not asked for citations: a refusal has no sources to cite, and
        listing the chunks that *failed* to answer the question would be worse than saying
        nothing. Populating it is the caller's decision, not this helper's.

        `strictness_applied` and `confidence_gate_passed` are written into `retrieval` for the
        log and the in-process debugger; `RetrievalInfo` marks both `exclude=True`, so they
        cannot appear in a response body however this dict is passed on.
        """

        final_res = {
            "status": "success",
            "response": base_res["response"],
            "fallback_required": base_res.get("fallback_required", False),
            "reason": base_res.get("reason"),
            "intent": {
                "predicted": classification["intent"],
                "confidence": classification["confidence"]
            },
            "retrieval": {
                "used_topic_filter": rag["used_topic_filter"],
                "top_score": rag["top_score"],
                "documents_found": len(rag["results"]),
                "strictness_applied": strictness_applied,
                "confidence_gate_passed": confidence_gate_passed
            },
            "sources": sources,
            "model_used": model_used,
            "failover_used": failover_used,
            "human_requested": human_requested,
        }

        # Add a copy to debug_info without circular reference
        debug_info["final_result"] = dict(final_res)

        # Add debug to the actual return payload
        final_res["debug"] = debug_info

        return final_res


_chat_service_instance = None


def get_chat_service() -> ChatService:
    """Dependency injector for ChatService singleton."""
    global _chat_service_instance
    if _chat_service_instance is None:
        _chat_service_instance = ChatService()
    return _chat_service_instance
