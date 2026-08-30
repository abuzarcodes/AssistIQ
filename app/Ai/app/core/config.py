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
    GEMINI_MODEL: str = "gemini-2.0-flash"

    # Embedding Provider Configuration
    EMBEDDING_PROVIDER: str = "openai"
    EMBEDDING_MODEL: str = "text-embedding-3-small"
    EMBEDDING_API_KEY: str = ""
    EMBEDDING_DIMENSION: int = 1536  # Default dimension for openai. 384 for huggingface.

    # Database Configuration (PostgreSQL + pgvector)
    DATABASE_URL: str = "postgresql://postgres:postgres@localhost:5432/assistiq"
    VECTOR_STORE_TABLE: str = "knowledge_chunks"

    # Redis Cache & Queue Configuration
    REDIS_URL: str = "redis://localhost:6379/0"

    # Express Backend Communication
    EXPRESS_BACKEND_URL: str = "http://localhost:5000"
    INTERNAL_API_KEY: str = "dev_internal_secret_key"
    
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
