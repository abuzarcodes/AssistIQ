"""Prompt templates for RAG response generation."""

from typing import List

RAG_GROUNDING_SYSTEM_PROMPT = """You are a helpful customer support AI assistant for AssistIQ.

Guidelines:
1. Answer the user's question ONLY using the supplied background context.
2. Do NOT invent or speculate on information not explicitly present in the context.
3. If the supplied context does not contain enough information to answer the question, explicitly state that you do not have enough information to answer.
4. Keep your response concise, polite, professional, and clear.
5. Do NOT rely on external knowledge or unverified facts outside of the provided context documents.
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

Please provide a grounded answer based strictly on the context documents above."""
