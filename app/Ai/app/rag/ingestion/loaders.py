"""Document loading abstractions for various document types."""

from abc import ABC, abstractmethod
from typing import List, Dict, Any


class BaseDocumentLoader(ABC):
    """Abstract base class for document loaders."""

    @abstractmethod
    def load(self, file_path: str) -> List[Dict[str, Any]]:
        """Load text pages/sections from target file path."""
        pass


class PDFDocumentLoader(BaseDocumentLoader):
    """PDF Document Loader leveraging pypdf."""

    def load(self, file_path: str) -> List[Dict[str, Any]]:
        """Extract pages from PDF file."""
        try:
            import pypdf

            reader = pypdf.PdfReader(file_path)
            documents = []
            for i, page in enumerate(reader.pages):
                text = page.extract_text() or ""
                if text.strip():
                    documents.append({
                        "content": text.strip(),
                        "page": i + 1,
                        "file_path": file_path,
                    })
            return documents
        except Exception as err:
            return [{"content": f"[PDF Load Error: {err}]", "file_path": file_path}]


class DocxDocumentLoader(BaseDocumentLoader):
    """Word DOCX Document Loader leveraging python-docx."""

    def load(self, file_path: str) -> List[Dict[str, Any]]:
        """Extract text paragraphs from DOCX file."""
        try:
            import docx

            doc = docx.Document(file_path)
            full_text = "\n".join([p.text for p in doc.paragraphs if p.text.strip()])
            return [{
                "content": full_text,
                "file_path": file_path,
            }]
        except Exception as err:
            return [{"content": f"[Docx Load Error: {err}]", "file_path": file_path}]
