"""Prompt templates for RAG response generation."""

from typing import List

RAG_GROUNDING_SYSTEM_PROMPT = """You are a helpful customer support AI assistant for AssistIQ.

Guidelines:
1. Answer the user's question using the supplied background context.
2. Do NOT invent or speculate on information not explicitly present in the context.
4. Keep your response concise, polite, professional, and clear.
"""


def build_rag_user_prompt(question: str, context_snippets: List[str]) -> str:
    """Combine user query and retrieved context snippets into final formatted LLM user prompt."""
    if not context_snippets:
        formatted_context = "No relevant context found."
    else:
        formatted_context = "\n---\n".join(context_snippets)

    return f"""Context Documents:
------------------
{formatted_context}
------------------

User Question: {question}

Please provide a grounded answer based on the context documents above."""
