"""Embedding Service for text and document vectorization."""

from typing import Dict, List, Any, Optional
from app.core.config import settings
from app.core.logging import logger, format_log_context


class EmbeddingError(Exception):
    """Base class for embedding failures that a caller must handle."""


class EmbeddingUnavailableError(EmbeddingError):
    """No provider is configured, so no embedding can be produced."""


class EmbeddingFailedError(EmbeddingError):
    """The configured provider was reachable in principle but the call failed."""


class EmbeddingService:
    """Service abstraction for embedding generation."""

    def __init__(self) -> None:
        self.provider = settings.EMBEDDING_PROVIDER.lower()
        self.model_name = settings.EMBEDDING_MODEL
        self.api_key = settings.EMBEDDING_API_KEY

        if self.provider == "huggingface":
            self.dimension = 384
            self._is_configured = True
        else:
            self.dimension = settings.EMBEDDING_DIMENSION
            self._is_configured = bool(self.api_key and self.api_key.strip())

        self._hf_model = None

    @property
    def is_configured(self) -> bool:
        """Check whether valid API credentials exist."""
        return self._is_configured

    @property
    def effective_model_name(self) -> str:
        """The model actually used, which is not always the configured name.

        `EMBEDDING_MODEL` defaults to an OpenAI id. Selecting the huggingface
        provider without overriding it therefore leaves a name this provider
        cannot load, and `_get_hf_model` substitutes the local default. Reporting
        the raw config value would label stored vectors with a model that never
        touched them, which is exactly what `embedding_model` metadata is for.
        """
        if self.provider == "huggingface" and self.model_name == "text-embedding-3-small":
            return "all-MiniLM-L6-v2"
        return self.model_name

    def get_model_info(self) -> Dict[str, Any]:
        """Describe the embedding model, for recording alongside stored vectors.

        `is_configured` is included so a caller can tell "this vector came from a
        real model" apart from "this vector is zeros because nothing was
        configured" — a distinction the vector itself cannot carry.
        """
        return {
            "provider": self.provider,
            "model": self.effective_model_name,
            "dimension": self.dimension,
            "is_configured": self.is_configured,
        }

    def _get_hf_model(self):
        """Lazy load HuggingFace sentence transformer."""
        if self._hf_model is None:
            from sentence_transformers import SentenceTransformer
            # We use all-MiniLM-L6-v2 directly if huggingface is selected
            model_id = self.effective_model_name
            self._hf_model = SentenceTransformer(model_id)
        return self._hf_model

    async def embed_text(self, text: str, strict: bool = False) -> List[float]:
        """Generate vector embedding for a single text string.

        Args:
            strict: When True, raise instead of substituting a zero vector.

                The lenient default exists for the FAQ ingestion path, where a
                missing key degrades a demo rather than corrupting anything. It is
                wrong for re-embedding: overwriting a good vector with zeros makes
                the chunk stop matching every query, silently and permanently —
                the user sees "re-embedded" and a chunk that can never be found
                again. Re-embed callers must pass `strict=True`.

        Raises:
            EmbeddingUnavailableError: strict mode, and no provider is configured.
            EmbeddingFailedError: strict mode, and the provider call failed.
        """
        if not self.is_configured:
            if strict:
                raise EmbeddingUnavailableError(
                    f"Embedding provider '{self.provider}' is not configured; refusing to "
                    "overwrite stored vectors with placeholder values."
                )
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
            elif self.provider == "huggingface":
                model = self._get_hf_model()
                # Run synchronously but wrap in list
                res = model.encode(text)
                return res.tolist()
            else:
                if strict:
                    raise EmbeddingUnavailableError(
                        f"Unknown embedding provider '{self.provider}'."
                    )
                return [0.0] * self.dimension
        except EmbeddingError:
            raise
        except Exception as err:
            logger.error(
                "Failed to generate embedding: %s",
                str(err),
                extra=format_log_context(
                    operation="embed_text",
                    error_type=err.__class__.__name__,
                ),
            )
            if strict:
                raise EmbeddingFailedError(
                    f"Embedding provider '{self.provider}' failed: {err}"
                ) from err
            return [0.0] * self.dimension

    async def embed_documents(self, texts: List[str], strict: bool = False) -> List[List[float]]:
        """Generate vector embeddings for a list of document strings.

        `strict` behaves as in `embed_text`. Note that in lenient mode a partial
        provider failure yields a list of zero vectors of the correct length, so a
        caller cannot detect the failure from the return value alone.
        """
        if not texts:
            return []

        if not self.is_configured:
            if strict:
                raise EmbeddingUnavailableError(
                    f"Embedding provider '{self.provider}' is not configured; refusing to "
                    f"store placeholder vectors for {len(texts)} chunks."
                )
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
            elif self.provider == "huggingface":
                model = self._get_hf_model()
                res = model.encode(texts)
                return [vec.tolist() for vec in res]
            else:
                if strict:
                    raise EmbeddingUnavailableError(
                        f"Unknown embedding provider '{self.provider}'."
                    )
                return [[0.0] * self.dimension for _ in texts]
        except EmbeddingError:
            raise
        except Exception as err:
            logger.error(
                "Failed to generate document embeddings: %s",
                str(err),
                extra=format_log_context(
                    operation="embed_documents",
                    error_type=err.__class__.__name__,
                ),
            )
            if strict:
                raise EmbeddingFailedError(
                    f"Embedding provider '{self.provider}' failed: {err}"
                ) from err
            return [[0.0] * self.dimension for _ in texts]


_embedding_service_instance: Optional[EmbeddingService] = None


def get_embedding_service() -> EmbeddingService:
    """Dependency injector for EmbeddingService singleton instance."""
    global _embedding_service_instance
    if _embedding_service_instance is None:
        _embedding_service_instance = EmbeddingService()
    return _embedding_service_instance
