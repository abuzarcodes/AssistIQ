"""Document Processing Service — Extracts text from PDF and DOCX files."""

import io
from dataclasses import dataclass
from typing import List, Optional, Tuple

from app.core.config import settings
from app.core.logging import logger, format_log_context


@dataclass(frozen=True)
class ExtractedDocument:
    """Text extracted from a document, plus where each part came from.

    Attributes:
        text: The full extracted text. This is what chunking runs on, so it is the
            single source of truth for character offsets.
        spans: ``(start, end, page_number)`` triples into ``text``. A chunk whose
            start offset falls in ``[start, end)`` came from ``page_number``.
            ``page_number`` is None for formats with no page concept (DOCX).
        segment_count: Number of source segments (PDF pages, DOCX paragraph runs)
            that contained text. This is the user-facing "pages extracted" number.
    """

    text: str
    spans: List[Tuple[int, int, Optional[int]]]
    segment_count: int

    def page_for_offset(self, offset: int) -> Optional[int]:
        """Return the page number containing ``offset``, or None if unknown."""
        for start, end, page_number in self.spans:
            if start <= offset < end:
                return page_number
        # An offset in the separator between two segments belongs to neither; fall
        # back to the following segment so a chunk never loses its provenance.
        for start, _, page_number in self.spans:
            if offset < start:
                return page_number
        return self.spans[-1][2] if self.spans else None


class DocumentService:
    """Extracts raw text content from uploaded document files."""

    SUPPORTED_EXTENSIONS = {".pdf", ".docx"}

    #: Separator placed between source segments when building the full text.
    #: Part of the offset contract — `page_for_offset` relies on it being counted.
    SEGMENT_SEPARATOR = "\n\n"

    def __init__(self) -> None:
        # Absolute safety ceiling. The Express server owns the operator-facing,
        # runtime-configurable limit and rejects oversized files before they get
        # here; this exists only so a mis-set limit upstream cannot make this
        # service buffer an unbounded body.
        self.max_file_size_bytes = settings.AI_MAX_FILE_SIZE_BYTES

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
        document = self.extract_text_with_pages(file_bytes, filename)
        return document.text, document.segment_count

    def extract_text_with_pages(self, file_bytes: bytes, filename: str) -> ExtractedDocument:
        """Extract text while preserving page/paragraph provenance.

        Prefer this over `extract_text` whenever chunk metadata needs a page
        number — the offsets it returns cannot be reconstructed afterwards.
        """
        ext = self._get_extension(filename)

        if ext not in self.SUPPORTED_EXTENSIONS:
            raise ValueError(
                f"Unsupported file type '{ext}'. Supported types: {', '.join(self.SUPPORTED_EXTENSIONS)}"
            )

        if len(file_bytes) > self.max_file_size_bytes:
            raise ValueError(
                f"File size ({len(file_bytes) / (1024 * 1024):.1f} MB) exceeds the "
                f"{self.max_file_size_bytes // (1024 * 1024)} MB limit."
            )

        if ext == ".pdf":
            segments = self._extract_pdf_segments(file_bytes, filename)
        elif ext == ".docx":
            segments = self._extract_docx_segments(file_bytes, filename)
        else:
            raise ValueError(f"No extractor available for '{ext}'")

        return self._assemble(segments)

    def _assemble(self, segments: List[Tuple[Optional[int], str]]) -> ExtractedDocument:
        """Join segments into one text while recording where each one landed."""
        parts: List[str] = []
        spans: List[Tuple[int, int, Optional[int]]] = []
        cursor = 0

        for index, (page_number, segment_text) in enumerate(segments):
            if index > 0:
                cursor += len(self.SEGMENT_SEPARATOR)
            start = cursor
            parts.append(segment_text)
            cursor += len(segment_text)
            spans.append((start, cursor, page_number))

        return ExtractedDocument(
            text=self.SEGMENT_SEPARATOR.join(parts),
            spans=spans,
            segment_count=len(segments),
        )

    def _extract_pdf_segments(self, file_bytes: bytes, filename: str) -> List[Tuple[Optional[int], str]]:
        """Extract text from a PDF, one segment per page that has text."""
        try:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(file_bytes))
            segments: List[Tuple[Optional[int], str]] = []

            for page_num, page in enumerate(reader.pages, start=1):
                text = page.extract_text()
                if text and text.strip():
                    # 1-based, and the *original* page number — not the index in
                    # `segments`, which would drift as blank pages are skipped.
                    segments.append((page_num, text.strip()))

            if not segments:
                raise ValueError("PDF contains no extractable text (may be image-based).")

            logger.info(
                f"Extracted text from PDF '{filename}': {len(segments)} pages, "
                f"{sum(len(s) for _, s in segments)} chars",
                extra=format_log_context(
                    operation="extract_pdf",
                    doc_name=filename,
                    pages=len(segments),
                    chars=sum(len(s) for _, s in segments),
                ),
            )

            return segments

        except ValueError:
            raise
        except Exception as e:
            logger.error(f"Failed to extract PDF '{filename}': {e}")
            raise ValueError(f"Failed to process PDF file: {str(e)}")

    def _extract_docx_segments(self, file_bytes: bytes, filename: str) -> List[Tuple[Optional[int], str]]:
        """Extract text from a DOCX, one segment per non-empty paragraph.

        DOCX has no page concept — pagination is decided at render time — so these
        segments carry ``page_number=None``. Reporting a paragraph index as a page
        number would be a fabrication.
        """
        try:
            from docx import Document

            doc = Document(io.BytesIO(file_bytes))
            paragraphs: List[str] = []

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

            logger.info(
                f"Extracted text from DOCX '{filename}': {len(paragraphs)} paragraphs, "
                f"{sum(len(p) for p in paragraphs)} chars",
                extra=format_log_context(
                    operation="extract_docx",
                    doc_name=filename,
                    paragraphs=len(paragraphs),
                    chars=sum(len(p) for p in paragraphs),
                ),
            )

            return [(None, paragraph) for paragraph in paragraphs]

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
