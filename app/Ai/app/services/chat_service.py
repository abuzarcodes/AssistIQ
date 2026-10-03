"""Deterministic Hybrid Chat Pipeline Service."""

from typing import Dict, Any, Optional
from app.services.classifier_service import get_classifier_service
from app.services.rag_service import get_rag_service
from app.services.llm_service import get_llm_service
from app.services.fallback_service import get_fallback_service
from app.providers import ProviderError, ProviderErrorKind, ProviderModelRef
from app.prompts.support_prompt import get_support_system_prompt, build_user_prompt
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


def reason_for_provider_error(err: ProviderError) -> str:
    """Map a typed provider failure onto the reason vocabulary Node shares.

    Falls back to `MODEL_ERROR` for a kind added to the enum but not to the table above:
    guessing `MODEL_UNAVAILABLE` would be an affirmative claim about the platform's
    configuration that this code cannot make.
    """
    return _PROVIDER_FAILURE_REASONS.get(err.kind, FALLBACK_REASON_MODEL_ERROR)


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
    ) -> Dict[str, Any]:
        """Execute the full Classify -> Route -> Retrieve -> Validate -> Generate pipeline.

        `model` is the catalog model Node resolved for this bot, or `None` to use the
        service's environment-configured default. It is threaded through as a **local**,
        never stored on `self`: this service is a process-wide singleton, and FastAPI
        serves requests concurrently, so an attribute would let one request's model leak
        into another's generation across the awaits below.
        """

        debug_info = {
            "input": {"message": message, "bot_id": bot_id}
        }
        
        # 1. Classify Intent
        classification_result = self.classifier.classify(message)
        debug_info["classification"] = classification_result
        
        intent = classification_result["intent"]
        
        # If confidence is too low, we might still want to do a general search, 
        # but let's check what the requirements say. If classification is bad,
        # the prompt says "Check if confidence > threshold. If not, fallback or route to general."
        # We will route to full general search if classification fails threshold,
        # but if it's REALLY low, maybe we fallback. For now, we just don't apply the topic filter.
        
        # 2. Route & Retrieve
        topic_filter = intent if classification_result["is_confident"] and intent != INTENT_GENERAL_SUPPORT else None
        
        debug_info["retrieval_strategy"] = {
            "used_topic_filter": topic_filter is not None,
            "topic": topic_filter
        }
        
        rag_result = await self.rag.search(
            query=message,
            bot_id=bot_id,
            top_k=3,
            topic_filter=topic_filter
        )
        
        debug_info["retrieval_results"] = rag_result["results"]
        debug_info["retrieval_confidence"] = {
            "top_score": rag_result["top_score"],
            "is_confident": rag_result["is_confident"]
        }
        
        # 3. Validate Retrieval
        if not rag_result["results"]:
            fallback_res = self.fallback.get_fallback(FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE, bot_id)
            return self._build_response(fallback_res, classification_result, rag_result, debug_info)
            
        # 4. Generate
        context_str = "\n\n".join([f"[{res['topic']}] {res['content']}" for res in rag_result["results"]])
        system_msg = get_support_system_prompt()
        user_msg = build_user_prompt(message, context_str)
        
        debug_info["generation"] = {
            "system_prompt": system_msg,
            "user_prompt": user_msg
        }
        
        try:
            llm_response = await self.llm.generate(
                prompt=user_msg,
                system_message=system_msg,
                temperature=0.0,  # Deterministic
                model=model,
            )
        except ProviderError as err:
            # A provider failure is an expected, reportable state, not a server error. It
            # becomes a reason-coded fallback here so Node escalates the conversation
            # exactly as it does for a conversational dead end (Checkpoint 6).
            #
            # Catching it in the pipeline rather than in the route is what makes that
            # structural: `api/routes/chat.py`'s `except Exception` -> 500 is unreachable
            # for a provider failure, because one can no longer escape this frame.
            return self._provider_failure_response(
                err, bot_id, classification_result, rag_result, debug_info
            )

        debug_info["generation"]["raw_response"] = llm_response
        
        # 5. Check LLM Fallback Signal
        if INSUFFICIENT_INFORMATION_SIGNAL in llm_response:
            fallback_res = self.fallback.get_fallback(FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION, bot_id)
            return self._build_response(fallback_res, classification_result, rag_result, debug_info)
            
        # Success
        success_res = {
            "fallback_required": False,
            "response": llm_response,
            "reason": None
        }
        return self._build_response(success_res, classification_result, rag_result, debug_info)

    def _provider_failure_response(
        self,
        err: ProviderError,
        bot_id: str,
        classification: Dict[str, Any],
        rag: Dict[str, Any],
        debug_info: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Turn a typed provider failure into an ordinary fallback pipeline result.

        The response shape is identical to every other fallback, which is the point: Node
        needs no new branch, and `fallback_required` alone drives the escalation.

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
        return self._build_response(fallback_res, classification, rag, debug_info)

    def _build_response(
        self, 
        base_res: Dict[str, Any], 
        classification: Dict[str, Any], 
        rag: Dict[str, Any],
        debug_info: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Helper to assemble the final ChatResponse payload."""
        
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
                "documents_found": len(rag["results"])
            }
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
