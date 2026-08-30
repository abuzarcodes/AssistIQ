"""LangGraph Agent state definition using TypedDict."""

from typing import TypedDict, List, Dict, Optional, Any


class AgentState(TypedDict):
    """Execution state passed through LangGraph workflow nodes."""

    question: str
    bot_id: str
    conversation_id: str
    workspace_id: Optional[str]
    intent: Optional[str]
    retrieved_context: List[str]
    sources: List[Dict[str, Any]]
    answer: str
    retrieval_confidence: float
    should_escalate: bool
