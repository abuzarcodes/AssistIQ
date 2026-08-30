"""Text preprocessing routines for intent classification."""

import re


def preprocess_text_for_intent(text: str) -> str:
    """Preprocess text for TF-IDF vectorization by lowercasing and stripping punctuation."""
    if not text:
        return ""
    text = text.lower()
    # Strip special punctuation while retaining words and numbers
    text = re.sub(r"[^\w\s]", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()
