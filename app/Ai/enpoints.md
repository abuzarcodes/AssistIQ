# AssistIQ AI Service - API Endpoints

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

**Description:** Retrieve operational status of LLM and Embedding provider configurations.

---

## chat_with_ai
**Path:** `/api/v1/ai/chat`

**Methods:** `POST`

**Description:** Process incoming chat query using LangGraph RAG pipeline.

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

**Description:** Main hybrid deterministic AI chat pipeline for answering user questions.

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

