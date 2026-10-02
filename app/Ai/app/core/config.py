"""Application settings configuration managed via pydantic-settings."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Global configuration settings for AssistIQ AI service."""

    # Application Settings
    APP_NAME: str = "AssistIQ AI Service"
    APP_ENV: str = "development"
    APP_HOST: str = "0.0.0.0"
    APP_PORT: int = 8000
    LOG_LEVEL: str = "INFO"

    # LLM Provider Configuration
    LLM_PROVIDER: str = "openai"
    LLM_MODEL: str = "gpt-4o-mini"
    LLM_API_KEY: str = ""
    
    # Grok Configuration
    GROK_API_KEY: str = ""
    GROK_MODEL: str = "grok-3-mini"
    
    # Gemini Configuration
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.6-flash"

    # OpenRouter Configuration (the first entry in the model catalog)
    #
    # These env vars are the ONLY place a provider credential lives. The Node backend has
    # no OpenRouter variable of any kind: it stores a provider slug and a model id, and
    # this service maps that slug to the credential. That asymmetry is what keeps the key
    # out of the application database, out of Node's logs, and off the wire to the browser.
    #
    # An empty OPENROUTER_API_KEY means "adapter available, credential absent" — a state
    # the platform dashboard reports rather than hides, so an operator sees the difference
    # between "not wired up yet" and "wired up and broken".
    OPENROUTER_API_KEY: str = ""
    OPENROUTER_BASE_URL: str = "https://openrouter.ai/api/v1"
    #: Seconds to wait for a completion. A provider that never answers must not hold a
    #: conversation open indefinitely; the timeout surfaces as a TIMEOUT ProviderError.
    OPENROUTER_REQUEST_TIMEOUT: float = 30.0
    #: OpenRouter's optional attribution headers (`HTTP-Referer` / `X-Title`). They are
    #: identifiers shown on the provider's dashboard, never credentials.
    OPENROUTER_SITE_URL: str = ""
    OPENROUTER_APP_NAME: str = "AssistIQ"

    # Embedding Provider Configuration
    EMBEDDING_PROVIDER: str = "openai"
    EMBEDDING_MODEL: str = "text-embedding-3-small"
    EMBEDDING_API_KEY: str = ""
    EMBEDDING_DIMENSION: int = 1536  # Default dimension for openai. 384 for huggingface.

    # Database Configuration (PostgreSQL + pgvector)
    DATABASE_URL: str = "postgresql://postgres:postgres@localhost:5432/assistiq_db"
    VECTOR_STORE_TABLE: str = "knowledge_chunks"

    # Service-to-Service Authentication
    # Shared secret the Node backend must present in the `X-API-Key` header.
    # Empty means "not configured" — protected routes then refuse every request (503)
    # rather than accepting unauthenticated traffic. See `app/core/auth.py`.
    AI_SERVICE_API_KEY: str = ""

    # AI Pipeline Thresholds
    CLASSIFICATION_CONFIDENCE_THRESHOLD: float = 0.60
    RETRIEVAL_CONFIDENCE_THRESHOLD: float = 0.65
    
    # Chunking Configuration
    CHUNK_SIZE: int = 800
    CHUNK_OVERLAP: int = 100

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )


settings = Settings()
