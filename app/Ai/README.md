# AssistIQ AI Service - Hybrid AI Engine (Review 1)

This is the independent Python FastAPI microservice powering the Intelligence Layer of the **AssistIQ** customer support platform. 

## Architecture

This service implements a deterministic hybrid AI pipeline to answer customer questions accurately without hallucinations.

The pipeline follows this exact flow:
1. **Classify**: Incoming messages are evaluated by an ML Intent Classifier (`TF-IDF + LogisticRegression`).
2. **Route**: If confidence is high, search is filtered to a specific topic. If low, a full search is performed.
3. **Retrieve**: pgvector performs semantic search using embeddings (`OpenAI` or `HuggingFace Sentence Transformers`).
4. **Validate**: If retrieval confidence is below threshold, the system gracefully falls back.
5. **Generate**: The LLM (`OpenAI`, `Gemini`, or `Grok`) generates a response grounded *strictly* in the retrieved context.
6. **Fallback**: If the LLM lacks sufficient information, it returns an explicit `INSUFFICIENT_INFORMATION` signal, triggering a graceful fallback.

## Prerequisites

1. **Python 3.10+**
2. **PostgreSQL with pgvector**: The database must have `CREATE EXTENSION vector;` executed.
3. API Keys (Optional if using free tiers):
   - OpenAI (for embeddings/LLM)
   - Gemini / Google AI Studio (Free LLM tier)
   - Grok / xAI (Free LLM tier)

## Setup

1. **Create Virtual Environment**:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   ```

2. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure Environment**:
   Copy `.env.example` to `.env` and fill in your keys. To run completely free:
   - `LLM_PROVIDER="gemini"` (Get key from Google AI Studio)
   - `EMBEDDING_PROVIDER="huggingface"` (Runs locally, no key needed)

4. **Train the ML Model**:
   You must train the intent classifier before starting the server.
   ```bash
   python -m app.ml.training.train
   ```

5. **Run the Server**:
   ```bash
   uvicorn app.main:app --reload --port 8000
   ```

## Demo & Testing Endpoints

Once the server is running, visit `http://localhost:8000/docs` to interact with Swagger UI.

1. **`GET /api/v1/testing/status`**: System status report.
2. **`GET /api/v1/ml/evaluate`**: See the real F1, Precision, and Recall scores of the intent classifier.
3. **`POST /api/v1/knowledge/ingest`**: Ingest JSON FAQ data for a `bot_id`. It will be chunked and saved to pgvector.
4. **`POST /api/v1/chat`**: Send a message to the full pipeline. The response includes `intent` and `retrieval` metadata.
5. **`POST /api/v1/testing/chat-pipeline`**: Extremely detailed debug endpoint showing raw inputs, chunks, strategy, and prompts.

## Multi-Tenancy

Every API endpoint requires a `bot_id`. The vector database strictly isolates searches using `WHERE bot_id = ?`. One tenant's data can never be exposed to another.
