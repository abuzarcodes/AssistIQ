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
    #
    # `GEMINI_API_KEY` is deliberately shared by two paths: the legacy env-driven path
    # (`LLM_PROVIDER=gemini`) and the catalog adapter registered as `gemini`. One
    # credential, one variable — a second one could disagree with the first, and the
    # platform dashboard would then report a provider as configured or not depending on
    # which of the two an operator happened to set.
    #
    # `GEMINI_MODEL` belongs to the legacy path only. The catalog supplies a model id per
    # request, so nothing here constrains which Gemini models a platform owner may
    # catalog.
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.6-flash"
    #: Seconds to wait for a completion from the catalog `gemini` adapter.
    GEMINI_REQUEST_TIMEOUT: float = 30.0

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

    # Remaining catalog providers
    #
    # Same rule as OpenRouter: these variables are the ONLY place the credential lives, and
    # this service is the only component that holds one. Node stores a provider slug and a
    # model id; it has no variable of any kind for any provider below. Add an adapter →
    # add a variable here → seed a matching `ai_providers` row. Three places, one slug.

    # Groq — fast inference on open-weight models, at groq.com.
    #
    # Not to be confused with Grok, xAI's model family, whose credential is `GROK_API_KEY`
    # in the legacy block above. The names differ by one letter and the two are unrelated
    # companies with unrelated APIs.
    GROQ_API_KEY: str = ""
    # The **host**, with no `/openai/v1` suffix — unlike every other `*_BASE_URL` here.
    # `langchain_groq.ChatGroq` delegates to the dedicated `groq` SDK, which hardcodes its
    # completions path as `/openai/v1/chat/completions` and defaults its own base to exactly
    # this value. Giving it the OpenAI-compatible `https://api.groq.com/openai/v1` that
    # `ChatOpenAI` expects makes the SDK add its prefix a second time, and every call 404s
    # at `/openai/v1/openai/v1/chat/completions`. The same name is read *by that SDK* as its
    # base, so this value is the single source of truth for both — keep them agreeing.
    GROQ_BASE_URL: str = "https://api.groq.com"
    GROQ_REQUEST_TIMEOUT: float = 30.0

    # OpenAI — the first-party API.
    #
    # Deliberately NOT `LLM_API_KEY`. That variable is generic: it holds whatever
    # `LLM_PROVIDER` currently points at, so with `LLM_PROVIDER=gemini` it holds a Gemini
    # key. Reading it here would report the OpenAI provider as configured while its
    # credential actually belonged to someone else. An operator who has set only
    # `LLM_API_KEY` therefore sees the OpenAI row as "credential missing", which is true
    # and actionable.
    OPENAI_API_KEY: str = ""
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    OPENAI_REQUEST_TIMEOUT: float = 30.0

    # Generic OpenAI-compatible slot — one configurable endpoint.
    #
    # A single catalog provider (`slug: openai_compatible`) for services that expose an
    # OpenAI-compatible API: Together, Fireworks, a local vLLM or Ollama, a corporate
    # gateway. The endpoint is configuration, so it lives here rather than in the
    # database; the display name is not, so it is seeded and can be renamed from the
    # platform dashboard.
    #
    # `is_configured` requires BOTH of these. Every other adapter requires a credential,
    # and langchain-openai itself demands an `api_key` value even against a server that
    # ignores it — so point this at a keyless local server (Ollama, vLLM) by giving it a
    # placeholder such as `not-needed`. Documented rather than special-cased: a readiness
    # badge that turns green for an endpoint with no key would be lying about a real
    # misconfiguration.
    OPENAI_COMPATIBLE_API_KEY: str = ""
    OPENAI_COMPATIBLE_BASE_URL: str = ""
    OPENAI_COMPATIBLE_REQUEST_TIMEOUT: float = 30.0

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
