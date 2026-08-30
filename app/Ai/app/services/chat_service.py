"""Deterministic Hybrid Chat Pipeline Service."""

from typing import Dict, Any
from app.services.classifier_service import get_classifier_service
from app.services.rag_service import get_rag_service
from app.services.llm_service import get_llm_service
from app.services.fallback_service import get_fallback_service
from app.prompts.support_prompt import get_support_system_prompt, build_user_prompt
from app.core.constants import (
    FALLBACK_REASON_LOW_CLASSIFICATION_CONFIDENCE,
    FALLBACK_REASON_NO_RELEVANT_KNOWLEDGE,
    FALLBACK_REASON_LOW_RETRIEVAL_CONFIDENCE,
    FALLBACK_REASON_LLM_INSUFFICIENT_INFORMATION,
    INSUFFICIENT_INFORMATION_SIGNAL,
    INTENT_GENERAL_SUPPORT
)
from app.core.logging import logger, format_log_context


class ChatService:
    """Coordinates the deterministic hybrid AI pipeline."""

    def __init__(self):
        self.classifier = get_classifier_service()
        self.rag = get_rag_service()
        self.llm = get_llm_service()
        self.fallback = get_fallback_service()

    async def process_chat(self, bot_id: str, message: str) -> Dict[str, Any]:
        """Execute the full Classify -> Route -> Retrieve -> Validate -> Generate pipeline."""
        
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
            
        if not rag_result["is_confident"]:
            fallback_res = self.fallback.get_fallback(FALLBACK_REASON_LOW_RETRIEVAL_CONFIDENCE, bot_id)
            return self._build_response(fallback_res, classification_result, rag_result, debug_info)
            
        # 4. Generate
        context_str = "\n\n".join([f"[{res['topic']}] {res['content']}" for res in rag_result["results"]])
        system_msg = get_support_system_prompt()
        user_msg = build_user_prompt(message, context_str)
        
        debug_info["generation"] = {
            "system_prompt": system_msg,
            "user_prompt": user_msg
        }
        
        llm_response = await self.llm.generate(
            prompt=user_msg,
            system_message=system_msg,
            temperature=0.0  # Deterministic
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
