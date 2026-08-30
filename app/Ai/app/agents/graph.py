"""LangGraph graph compilation and execution entry point."""

from typing import Dict, Any
from langgraph.graph import StateGraph, START, END
from app.agents.state import AgentState
from app.agents.nodes import retrieve_node, generate_node


def create_agent_graph():
    """Construct and compile initial LangGraph workflow."""
    workflow = StateGraph(AgentState)

    # Add workflow nodes
    workflow.add_node("retrieve", retrieve_node)
    workflow.add_node("generate", generate_node)

    # Add workflow edges
    workflow.add_edge(START, "retrieve")
    workflow.add_edge("retrieve", "generate")
    workflow.add_edge("generate", END)

    return workflow.compile()


compiled_agent_graph = create_agent_graph()


async def run_agent_graph(
    question: str,
    bot_id: str,
    conversation_id: str,
    workspace_id: str | None = None,
) -> Dict[str, Any]:
    """Execute compiled LangGraph agent graph given initial input parameters."""
    initial_state: AgentState = {
        "question": question,
        "bot_id": bot_id,
        "conversation_id": conversation_id,
        "workspace_id": workspace_id,
        "intent": None,
        "retrieved_context": [],
        "sources": [],
        "answer": "",
        "retrieval_confidence": 0.0,
        "should_escalate": False,
    }

    final_state = await compiled_agent_graph.ainvoke(initial_state)
    return final_state
