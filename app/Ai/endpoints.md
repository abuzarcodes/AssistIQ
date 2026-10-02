# AssistIQ AI Service - API Endpoints

> **Two chat pipelines exist.** `POST /api/v1/chat` is the production pipeline used by
> the Express backend. `POST /api/v1/ai/chat` is an **experimental** LangGraph variant
> (not called by the backend or the browser; its retrieval node uses a mock provider).

## openapi
**Path:** `/openapi.json`

**Methods:** `HEAD, GET`

**Description:** 

---

## swagger_ui_html
**Path:** `/docs`

**Methods:** `HEAD, GET`

**Description:** 

---

## swagger_ui_redirect
**Path:** `/docs/oauth2-redirect`

**Methods:** `HEAD, GET`

**Description:** 

---

## redoc_html
**Path:** `/redoc`

**Methods:** `HEAD, GET`

**Description:** 

---

## health_check
**Path:** `/health`

**Methods:** `GET`

**Description:** Independent health check endpoint returning basic status.

---

## get_ai_status
**Path:** `/api/v1/ai/status`

**Methods:** `GET`

**Description:** Retrieve operational status of LLM and Embedding provider configurations. Also reports `provider_adapters` — every registered provider adapter and whether its credential is present. Reading it calls `is_configured`, which reads settings: **no provider is contacted**, and no credential-derived value is returned.

---

## chat_with_ai
**Path:** `/api/v1/ai/chat`

**Methods:** `POST`

**Description:** [EXPERIMENTAL] Process incoming chat query using the LangGraph RAG pipeline. Not the production chat path.

---

## classify_text
**Path:** `/api/v1/ml/classify`

**Methods:** `POST`

**Description:** Classify intent of user text with confidence scores.

---

## get_ml_status
**Path:** `/api/v1/ml/status`

**Methods:** `GET`

**Description:** Get intent classifier model status and loaded classes.

---

## evaluate_ml_model
**Path:** `/api/v1/ml/evaluate`

**Methods:** `GET`

**Description:** Run evaluation metrics on the ML model against test data.

---

## ingest_knowledge
**Path:** `/api/v1/knowledge/ingest`

**Methods:** `POST`

**Description:** Ingest structured knowledge entries, chunk them, embed, and store in vector database.

---

## ingest_document
**Path:** `/api/v1/knowledge/ingest-document`

**Methods:** `POST`

**Description:** Upload a PDF or DOCX file (multipart: `file`, `bot_id`, `topic`), extract text, and ingest into the RAG pipeline.

---

## delete_bot_knowledge
**Path:** `/api/v1/knowledge/{bot_id}`

**Methods:** `DELETE`

**Description:** Delete all vector knowledge for a specific bot.

---

## search_vectors
**Path:** `/api/v1/rag/search`

**Methods:** `POST`

**Description:** Perform a vector similarity search across a bot's knowledge chunks.

---

## chat_pipeline
**Path:** `/api/v1/chat`

**Methods:** `POST`

**Description:** Main hybrid deterministic AI chat pipeline for answering user questions. Accepts an **optional** `model: { provider, model_id }` descriptor, built by the Node backend from the bot's catalog model — never from client input. Absent means the request runs on the service's environment-configured default, which is the pre-catalog behaviour. The provider slug is validated against the adapter registry; the model id is passed verbatim to that adapter, because this service holds no catalog.

---

## get_system_status
**Path:** `/api/v1/testing/status`

**Methods:** `GET`

**Description:** Get health status of all subsystems (ML, VectorDB, LLM).

---

## get_vector_stats
**Path:** `/api/v1/testing/vector-store/stats`

**Methods:** `GET`

**Description:** Get detailed statistics about the pgvector database.

---

## debug_chat_pipeline
**Path:** `/api/v1/testing/chat-pipeline`

**Methods:** `POST`

**Description:** Run the chat pipeline and return full debug trace information.

---

