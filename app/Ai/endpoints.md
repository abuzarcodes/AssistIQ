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

**Description:** Upload a PDF or DOCX file (multipart: `file`, `bot_id`, optional `source_id`, optional `topic`), extract text, chunk it, embed it, and store the vectors. `source_id` is the server's `knowledge_sources` row id; the vectors it writes carry it, which is what lets a source be deleted by id later. A file that cannot be read at all — malformed PDF, structurally valid DOCX with no text, unsupported extension, zero bytes — is a **400** carrying the extractor's own explanation rather than a generic fault, because the server records that message as the source's `errorMessage` and it is what the user sees against a failed document. An embedding provider that is unavailable is **503**; one that fails is **502**; a missing vector store is **503**.

---

## re_embed_chunk
**Path:** `/api/v1/knowledge/chunks/{chunk_id}/re-embed`

**Methods:** `POST`

**Description:** Replace a chunk's text and regenerate its vector (`content` in the body, `bot_id` query). Never writes a placeholder vector: if the embedding provider fails, the stored vector is left as it was and the caller gets an error. **404** if the chunk is unknown to this bot; **503** if the embedding provider is unavailable or the vector store is unreachable; **502** if embedding fails; **400** if the content is rejected.

---

## toggle_chunk
**Path:** `/api/v1/knowledge/chunks/{chunk_id}/toggle`

**Methods:** `PATCH`

**Description:** Enable or disable one chunk's vector (`enabled` in the body, `bot_id` query), removing it from or restoring it to retrieval. No re-embedding: the vector is untouched, only its `enabled` flag changes, and the search's `AND enabled = true` clause is what takes effect. **404** if the chunk is unknown to this bot.

---

## bulk_delete_chunks
**Path:** `/api/v1/knowledge/chunks/bulk`

**Methods:** `DELETE`

**Description:** Delete several chunks' vectors in one call (`chunk_ids` in the body, `bot_id` query). Declared before `/chunks/{chunk_id}` so the literal `bulk` is not captured as a chunk id. Returns the number of chunks deleted.

---

## bulk_toggle_chunks
**Path:** `/api/v1/knowledge/chunks/bulk-toggle`

**Methods:** `POST`

**Description:** Enable or disable several chunks' vectors in one call (`chunk_ids` and `enabled` in the body, `bot_id` query). Returns the number affected.

---

## delete_chunk
**Path:** `/api/v1/knowledge/chunks/{chunk_id}`

**Methods:** `DELETE`

**Description:** Delete one chunk's vector (`bot_id` query). **404** when the chunk is unknown — the caller treats that as "already gone" and proceeds to delete its mirror row, so the two stores converge instead of leaving an undeletable row behind.

---

## bulk_delete_source_vectors
**Path:** `/api/v1/knowledge/sources/bulk`

**Methods:** `DELETE`

**Description:** Delete the vectors of several sources at once (`source_ids` in the body, `bot_id` query). Declared before `/sources/{source_id}` so the literal `bulk` is not captured as a source id. An empty list issues no statement and deletes nothing. **This is what "delete all FAQ entries" calls.** It must not be confused with `DELETE /{bot_id}`: a bot's vectors come from both uploaded documents and FAQ entries, so deleting by bot would take the documents' vectors along with the FAQs'. The caller names the sources it means.

---

## delete_source_vectors
**Path:** `/api/v1/knowledge/sources/{source_id}`

**Methods:** `DELETE`

**Description:** Delete every vector belonging to one knowledge source (`bot_id` query). Called when a source is deleted on the server: Prisma's cascade removes the `knowledge_sources` row and its `knowledge_chunks_meta` children, but it cannot reach these vectors — they live in a different PostgreSQL database. Without this call the vectors outlive the source and keep being retrieved for a document the user deleted. Returns the number of vectors removed.

---

## delete_bot_knowledge
**Path:** `/api/v1/knowledge/{bot_id}`

**Methods:** `DELETE`

**Description:** Delete all vector knowledge for a specific bot. Called when the bot itself is deleted, and only then — it is the broadest delete this service offers, and the only caller that legitimately wants every vector a bot owns to go. Returns the number of vectors removed.

---

## search_vectors
**Path:** `/api/v1/rag/search`

**Methods:** `POST`

**Description:** Perform a vector similarity search across a bot's knowledge chunks. Disabled chunks are excluded in SQL (`AND enabled = true`), which is also the filter production chat retrieval goes through — there is one funnel, not two. Returns the rows verbatim with their scores; the caller decides what to do about a low score, because filtering below a threshold here would let a weak row consume a `top_k` slot and then be discarded.

---

## chat_pipeline
**Path:** `/api/v1/chat`

**Methods:** `POST`

**Description:** Main hybrid deterministic AI chat pipeline for answering user questions. Accepts an **optional** `model: { provider, model_id }` descriptor, built by the Node backend from the bot's catalog model — never from client input. Absent means the request runs on the service's environment-configured default, which is the pre-catalog behaviour. The provider slug is validated against the adapter registry; the model id is passed verbatim to that adapter, because this service holds no catalog.

Additional optional fields (all backward compatible; absent reproduces the pre-feature pipeline exactly):
- `fallback_model: { provider, model_id }` — a second catalog model. Used **only** to retry the generation step once when `model` fails in a failover-eligible way (rate limit, upstream 5xx, timeout, unknown; auth/not-configured only when the fallback is a different provider). Node resolves both; this service never chooses a model.
- `config` — the bot's effective configuration, resolved by Node. Carries `personality`, `tone`, `custom_personality`, `custom_instructions`, `response_language`, `response_length`, `knowledge` (`enabled`, `strictness`, `show_sources`, `top_k`), `params` (`temperature`, `top_p`, `frequency_penalty`, `presence_penalty`, `max_tokens`) and `fallback.message`. **Absent means legacy behaviour**, not "the defaults".

The response gains `sources` (identifiers only, present only when `knowledge.show_sources`), `model_used` and `failover_used` (Node-only; logged, never forwarded to the browser), and `human_requested` (a detection Node acts on via `humanRequestBehavior`). `RetrievalInfo.strictness_applied` / `confidence_gate_passed` are server-side only and excluded from serialisation.

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

