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

    # Embedding Provider Configuration
    EMBEDDING_PROVIDER: str = "openai"
    EMBEDDING_MODEL: str = "text-embedding-3-small"
    EMBEDDING_API_KEY: str = ""

    # Database Configuration (PostgreSQL + pgvector)
    DATABASE_URL: str = "postgresql://postgres:postgres@localhost:5432/assistiq"

    # Redis Cache & Queue Configuration
    REDIS_URL: str = "redis://localhost:6379/0"

    # Express Backend Communication
    EXPRESS_BACKEND_URL: str = "http://localhost:5000"
    INTERNAL_API_KEY: str = "dev_internal_secret_key"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )


settings = Settings()
