"""Text cleaning and normalization utilities for RAG ingestion."""

import re


class TextCleaner:
    """Text cleaning utility for normalizing raw ingested document text."""

    def clean(self, text: str) -> str:
        """Clean raw text string by normalizing whitespace and special characters."""
        if not text:
            return ""

        # Normalize whitespace (replace tabs, multiple newlines and trailing spaces)
        cleaned = re.sub(r"\r\n", "\n", text)
        cleaned = re.sub(r"[ \t]+", " ", cleaned)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
        
        return cleaned.strip()
