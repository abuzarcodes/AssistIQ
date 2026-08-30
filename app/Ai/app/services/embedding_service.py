"""Embedding Service for text and document vectorization."""

from typing import List, Optional
from app.core.config import settings
from app.core.logging import logger, format_log_context


class EmbeddingService:
    """Service abstraction for embedding generation."""

    def __init__(self) -> None:
        self.provider = settings.EMBEDDING_PROVIDER.lower()
        self.model_name = settings.EMBEDDING_MODEL
        self.api_key = settings.EMBEDDING_API_KEY
        self._is_configured = bool(self.api_key and self.api_key.strip())
        self.dimension = 1536  # Default dimension for text-embedding-3-small

    @property
    def is_configured(self) -> bool:
        """Check whether valid API credentials exist."""
        return self._is_configured

    async def embed_text(self, text: str) -> List[float]:
        """Generate vector embedding for a single text string."""
        if not self.is_configured:
            logger.info(
                "Embedding API key not configured. Returning mock vector.",
                extra=format_log_context(operation="embed_text", provider=self.provider),
            )
            return [0.0] * self.dimension

        try:
            if self.provider == "openai":
                from langchain_openai import OpenAIEmbeddings

                embeddings = OpenAIEmbeddings(
                    model=self.model_name,
                    api_key=self.api_key,
                )
                res = await embeddings.aembed_query(text)
                return list(res)
            else:
                return [0.0] * self.dimension
        except Exception as err:
            logger.error(
                "Failed to generate embedding: %s",
                str(err),
                extra=format_log_context(
                    operation="embed_text",
                    error_type=err.__class__.__name__,
                ),
            )
            return [0.0] * self.dimension

    async def embed_documents(self, texts: List[str]) -> List[List[float]]:
        """Generate vector embeddings for a list of document strings."""
        if not texts:
            return []

        if not self.is_configured:
            logger.info(
                "Embedding API key not configured. Returning mock vectors.",
                extra=format_log_context(operation="embed_documents", provider=self.provider),
            )
            return [[0.0] * self.dimension for _ in texts]

        try:
            if self.provider == "openai":
                from langchain_openai import OpenAIEmbeddings

                embeddings = OpenAIEmbeddings(
                    model=self.model_name,
                    api_key=self.api_key,
                )
                res = await embeddings.aembed_documents(texts)
                return [list(vec) for vec in res]
            else:
                return [[0.0] * self.dimension for _ in texts]
        except Exception as err:
            logger.error(
                "Failed to generate document embeddings: %s",
                str(err),
                extra=format_log_context(
                    operation="embed_documents",
                    error_type=err.__class__.__name__,
                ),
            )
            return [[0.0] * self.dimension for _ in texts]


_embedding_service_instance: Optional[EmbeddingService] = None


def get_embedding_service() -> EmbeddingService:
    """Dependency injector for EmbeddingService singleton instance."""
    global _embedding_service_instance
    if _embedding_service_instance is None:
        _embedding_service_instance = EmbeddingService()
    return _embedding_service_instance
