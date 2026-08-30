"""ML model resolution helpers."""

import os
from pathlib import Path

# Path resolving to models/ directory relative to root app/Ai
MODELS_DIR = Path(__file__).resolve().parent.parent.parent.parent / "models"


def get_model_path(model_filename: str) -> Path:
    """Return absolute path to model binary in models directory."""
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    return MODELS_DIR / model_filename
