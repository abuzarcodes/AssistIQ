"""Configurable text chunking interface for RAG document processing."""

from typing import List, Dict, Any


class TextChunker:
    """Configurable character/token text chunker supporting sliding window overlap."""

    def __init__(self, chunk_size: int = 500, chunk_overlap: int = 50) -> None:
        if chunk_overlap >= chunk_size:
            raise ValueError("chunk_overlap must be strictly less than chunk_size")
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap

    def split_text(self, text: str) -> List[str]:
        """Split single text block into chunks with configured size and overlap."""
        return [chunk for _, _, chunk in self.split_text_with_offsets(text)]

    def split_text_with_offsets(self, text: str) -> List[tuple]:
        """Split text into chunks, also reporting each chunk's span in the source.

        Returns:
            A list of ``(start, end, chunk)`` tuples where ``text[start:end] == chunk``.

        The offsets are what let a caller attribute a chunk to its originating page
        without re-searching for the chunk text — a search would be ambiguous, since
        overlapping chunks and repeated boilerplate make chunk text non-unique.
        """
        if not text:
            return []

        chunks: List[tuple] = []
        start = 0
        text_len = len(text)

        while start < text_len:
            end = start + self.chunk_size
            chunks.append((start, min(end, text_len), text[start:end]))

            if end >= text_len:
                break

            start += self.chunk_size - self.chunk_overlap

        return chunks

    def split_documents(self, documents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Split list of loaded document objects into chunked metadata records."""
        chunked_docs = []
        for doc_idx, doc in enumerate(documents):
            content = doc.get("content", "")
            sub_chunks = self.split_text(content)
            for chunk_idx, chunk_str in enumerate(sub_chunks):
                chunk_record = dict(doc)
                chunk_record["content"] = chunk_str
                chunk_record["chunk_index"] = chunk_idx
                chunk_record["parent_doc_index"] = doc_idx
                chunked_docs.append(chunk_record)
        return chunked_docs
