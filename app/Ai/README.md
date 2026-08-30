# AssistIQ - Python AI/ML Service

## 1. Overview & Service Purpose
The **AssistIQ AI/ML Service** is an independent, highly scalable Python microservice responsible for all AI, Machine Learning, RAG (Retrieval-Augmented Generation), and document processing functionalities across the AssistIQ multi-tenant customer support SaaS platform.

## 2. Why a Separate AI Service?
Separating the AI service from the main Express/Node.js backend offers key architectural benefits:
- **Ecosystem Fit**: Native access to Python's robust AI/ML ecosystem (LangChain, LangGraph, scikit-learn, PyPDF, Pandas, NumPy).
- **Independent Scalability**: Heavy ML model inference and vector operations can scale horizontally on GPU/CPU instances independently of web application traffic.
- **Clear Boundaries**: Express retains ownership of core tenant domain data (authentication, billing, workspaces, user data, websockets), while Python manages computational AI workloads.

---

## 3. High-Level Architecture

```text
  Customer Client (Next.js)
            │
            ▼
    Express Backend (Node.js / TypeScript) ── PostgreSQL + pgvector
            │
            ▼ (Internal HTTP REST APIs)
    Python AI/ML Service (FastAPI)
      ├── Intent Classifier (Scikit-Learn)
      ├── Human Escalation Model (Scikit-Learn)
      ├── LangGraph Workflow Agent
      └── RAG Retrieval & Answer Generator
```

---

## 4. Directory Structure

```text
app/Ai/
├── app/
│   ├── main.py                  # FastAPI Application Factory & Lifespan
│   ├── api/
│   │   └── routes/
│   │       ├── health.py        # Unconditional GET /health endpoint
│   │       └── ai.py            # Versioned GET /api/v1/ai/status & POST /api/v1/ai/chat
│   ├── core/
│   │   ├── config.py            # Pydantic-settings configuration
│   │   ├── logging.py           # Structured logging setup
│   │   └── exceptions.py       # Custom exceptions & FastAPI exception handlers
│   ├── schemas/
│   │   ├── common.py            # Standardized API response envelopes
│   │   └── ai.py                # AIChatRequest and AIChatResponse models
│   ├── services/
│   │   ├── llm_service.py       # Isolated LLM provider wrapper
│   │   ├── embedding_service.py # Text & document vector embedding wrapper
│   │   ├── retrieval_service.py # Vector database retrieval interface
│   │   └── ml_service.py        # ML inference orchestrator
│   ├── rag/
│   │   ├── ingestion/           # Loaders (PDF/Docx), Cleaners, & TextChunker
│   │   ├── retrieval/           # Retriever & ChunkMetadata definitions
│   │   ├── generation/          # Grounding system prompts & AnswerGenerator
│   │   └── pipeline.py          # RAG end-to-end pipeline coordinator
│   ├── agents/
│   │   ├── state.py             # AgentState TypedDict
│   │   ├── nodes.py             # LangGraph retrieve & generate nodes
│   │   └── graph.py             # Compiled StateGraph workflow
│   ├── ml/
│   │   ├── intent/              # Scikit-learn TF-IDF + LogisticRegression model
│   │   ├── escalation/          # Human escalation model feature definitions & model placeholder
│   │   └── common/              # Model path helpers & joblib utilities
│   └── utils/
│       └── helpers.py           # Helper utilities
├── tests/
│   ├── conftest.py              # Pytest AsyncClient fixtures
│   ├── test_health.py           # Health endpoint tests
│   └── test_ai.py               # AI endpoint & validation tests
├── models/                      # Trained scikit-learn binary artifacts (.joblib)
├── data/                        # Raw & processed ingestion samples
├── .env.example                 # Environment configuration template
├── .gitignore                   # Python & model artifact ignore rules
├── requirements.txt             # Pinned project dependencies
├── Dockerfile                   # Docker container build script
└── README.md                    # Service documentation
```

---

## 5. Setup & Virtual Environment

### Prerequisites
- Python 3.12 (Recommended)

### Create Virtual Environment (`.venv`)

**Windows (PowerShell/CMD):**
```powershell
python -m venv .venv
.venv\Scripts\activate
```

**Linux / macOS:**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

### Install Dependencies
```bash
pip install -r requirements.txt
```

---

## 6. Environment Variables

Copy `.env.example` to `.env`:

**Windows:**
```powershell
copy .env.example .env
```

**Linux / macOS:**
```bash
cp .env.example .env
```

The service runs out-of-the-box with mock/placeholder fallbacks if `LLM_API_KEY` or `EMBEDDING_API_KEY` are not set.

---

## 7. Running the Service

Start the Uvicorn server in reload mode:

```bash
uvicorn app.main:app --reload --port 8000
```

Access API Documentation:
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

---

## 8. Running Tests

Run unit test suite with `pytest`:

```bash
pytest
```

---

## 9. RAG Pipeline Architecture
The RAG system follows a modular flow:
1. **Document Ingestion**: PDF (`PDFDocumentLoader`) and Word (`DocxDocumentLoader`) parsing.
2. **Cleaning**: Normalization via `TextCleaner`.
3. **Chunking**: Character/token sliding window splitting via `TextChunker` (configurable `chunk_size` & `chunk_overlap`).
4. **Multi-Tenant Retrieval**: Retrieval requests are strictly scoped by `bot_id` and `workspace_id`.
5. **Grounded Generation**: Answers are restricted to supplied context using strict grounding prompts in `app/rag/generation/prompts.py`.

---

## 10. ML Model Architecture
In addition to LLMs, the service houses custom scikit-learn models:
- **Intent Classification**: Uses `TfidfVectorizer` + `LogisticRegression` to classify intent tags (e.g. `account_support`, `billing_inquiry`, `technical_support`). Training is executed separately; inference runs via `predict_intent()`.
- **Human Escalation Prediction**: Predicts whether customer queries require human agent intervention based on features like retrieval confidence score, query length, intent, and sentiment.

---

## 11. Express Backend Communication Flow
1. Next.js frontend sends user message to Node.js Express backend via WebSocket/HTTP.
2. Express makes an internal authenticated HTTP request to Python AI service:
   `POST http://localhost:8000/api/v1/ai/chat`
3. Python service classifies intent, runs RAG retrieval, invokes LLM, evaluates escalation, and returns response JSON:
```json
{
  "answer": "To reset your password, visit the settings menu...",
  "intent": "account_support",
  "should_escalate": false,
  "confidence": 0.95,
  "sources": []
}
```
4. Express routes response back to Next.js user interface.
