"""Document Processing Service — Extracts text from PDF and DOCX files."""

import io
from typing import Tuple

from app.core.logging import logger, format_log_context


class DocumentService:
    """Extracts raw text content from uploaded document files."""

    SUPPORTED_EXTENSIONS = {".pdf", ".docx"}
    MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB

    def extract_text(self, file_bytes: bytes, filename: str) -> Tuple[str, int]:
        """
        Extract text from a file based on its extension.

        Args:
            file_bytes: Raw bytes of the uploaded file.
            filename: Original filename (used to determine type).

        Returns:
            Tuple of (extracted_text, pages_or_paragraphs_count).

        Raises:
            ValueError: If the file type is unsupported or extraction fails.
        """
        ext = self._get_extension(filename)

        if ext not in self.SUPPORTED_EXTENSIONS:
            raise ValueError(
                f"Unsupported file type '{ext}'. Supported types: {', '.join(self.SUPPORTED_EXTENSIONS)}"
            )

        if len(file_bytes) > self.MAX_FILE_SIZE_BYTES:
            raise ValueError(
                f"File size ({len(file_bytes) / (1024*1024):.1f} MB) exceeds the 10 MB limit."
            )

        if ext == ".pdf":
            return self._extract_pdf(file_bytes, filename)
        elif ext == ".docx":
            return self._extract_docx(file_bytes, filename)
        else:
            raise ValueError(f"No extractor available for '{ext}'")

    def _extract_pdf(self, file_bytes: bytes, filename: str) -> Tuple[str, int]:
        """Extract text from a PDF file using pypdf."""
        try:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(file_bytes))
            pages = []

            for page_num, page in enumerate(reader.pages):
                text = page.extract_text()
                if text and text.strip():
                    pages.append(text.strip())

            if not pages:
                raise ValueError("PDF contains no extractable text (may be image-based).")

            full_text = "\n\n".join(pages)

            logger.info(
                f"Extracted text from PDF '{filename}': {len(pages)} pages, {len(full_text)} chars",
                extra=format_log_context(
                    operation="extract_pdf",
                    doc_name=filename,
                    pages=len(pages),
                    chars=len(full_text),
                ),
            )

            return full_text, len(pages)

        except ValueError:
            raise
        except Exception as e:
            logger.error(f"Failed to extract PDF '{filename}': {e}")
            raise ValueError(f"Failed to process PDF file: {str(e)}")

    def _extract_docx(self, file_bytes: bytes, filename: str) -> Tuple[str, int]:
        """Extract text from a DOCX file using python-docx."""
        try:
            from docx import Document

            doc = Document(io.BytesIO(file_bytes))
            paragraphs = []

            for para in doc.paragraphs:
                text = para.text.strip()
                if text:
                    paragraphs.append(text)

            # Also extract text from tables
            for table in doc.tables:
                for row in table.rows:
                    row_texts = [cell.text.strip() for cell in row.cells if cell.text.strip()]
                    if row_texts:
                        paragraphs.append(" | ".join(row_texts))

            if not paragraphs:
                raise ValueError("DOCX contains no extractable text.")

            full_text = "\n\n".join(paragraphs)

            logger.info(
                f"Extracted text from DOCX '{filename}': {len(paragraphs)} paragraphs, {len(full_text)} chars",
                extra=format_log_context(
                    operation="extract_docx",
                    doc_name=filename,
                    paragraphs=len(paragraphs),
                    chars=len(full_text),
                ),
            )

            return full_text, len(paragraphs)

        except ValueError:
            raise
        except Exception as e:
            logger.error(f"Failed to extract DOCX '{filename}': {e}")
            raise ValueError(f"Failed to process DOCX file: {str(e)}")

    @staticmethod
    def _get_extension(filename: str) -> str:
        """Get the lowercased file extension."""
        import os
        _, ext = os.path.splitext(filename)
        return ext.lower()


_document_service_instance = None


def get_document_service() -> DocumentService:
    """Dependency injector for DocumentService singleton."""
    global _document_service_instance
    if _document_service_instance is None:
        _document_service_instance = DocumentService()
    return _document_service_instance
