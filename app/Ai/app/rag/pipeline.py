"""RAG Pipeline coordinating document ingestion and retrieval flow."""

from typing import List, Dict, Any, Optional
from app.rag.ingestion.loaders import PDFDocumentLoader, DocxDocumentLoader
from app.rag.ingestion.cleaners import TextCleaner
from app.rag.ingestion.chunker import TextChunker
from app.rag.retrieval.retriever import RAGRetriever
from app.rag.generation.generator import AnswerGenerator
from app.schemas.ai import SourceDocument


class RAGPipeline:
    """High-level pipeline orchestrating text cleaning, chunking, retrieval, and answer generation."""

    def __init__(
        self,
        chunker: Optional[TextChunker] = None,
        cleaner: Optional[TextCleaner] = None,
        retriever: Optional[RAGRetriever] = None,
        generator: Optional[AnswerGenerator] = None,
    ) -> None:
        self.cleaner = cleaner or TextCleaner()
        self.chunker = chunker or TextChunker(chunk_size=500, chunk_overlap=50)
        self.retriever = retriever or RAGRetriever()
        self.generator = generator or AnswerGenerator()

    def process_raw_document(self, text: str) -> List[str]:
        """Clean and chunk raw text input."""
        cleaned = self.cleaner.clean(text)
        return self.chunker.split_text(cleaned)

    async def execute_query(
        self,
        question: str,
        bot_id: str,
        workspace_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Execute complete RAG flow: retrieval -> ground prompt -> generate answer."""
        sources: List[SourceDocument] = await self.retriever.get_relevant_documents(
            query=question,
            bot_id=bot_id,
            workspace_id=workspace_id,
        )

        context_snippets = [doc.content for doc in sources]
        answer = await self.generator.generate_answer(question, context_snippets)

        # Estimate retrieval confidence from top source score
        confidence = sources[0].score if sources else 0.0

        return {
            "answer": answer,
            "sources": sources,
            "confidence": confidence,
        }
