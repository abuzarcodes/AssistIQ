# AssistIQ Node.js API Endpoints

This document describes the API endpoints provided by the Node.js/Express backend (`app/server`).
Unless specified as public, all endpoints require authentication via a Bearer token in the `Authorization` header (`Authorization: Bearer <token>`).

Base URL: `http://localhost:5000/api/v1`

---

## 1. Authentication (Public)

### POST `/auth/register`
- **Description:** Register a new user account. Rate-limited.
- **Input (JSON):**
  ```json
  {
    "name": "string (1-120 chars)",
    "email": "string (valid email)",
    "password": "string (8-128 chars)"
  }
  ```
- **Output (201 Created):**
  ```json
  {
    "success": true,
    "message": "User registered successfully",
    "data": {
      "user": { "id": "uuid", "name": "...", "email": "..." },
      "token": "jwt_token_string"
    }
  }
  ```

### POST `/auth/login`
- **Description:** Authenticate and receive a JWT token. Rate-limited.
- **Input (JSON):**
  ```json
  {
    "email": "string",
    "password": "string"
  }
  ```
- **Output (200 OK):**
  ```json
  {
    "success": true,
    "message": "Login successful",
    "data": {
      "user": { "id": "uuid", "name": "...", "email": "..." },
      "token": "jwt_token_string"
    }
  }
  ```

### POST `/auth/logout`
- **Description:** Invalidate session (client side clears token, server confirms).
- **Output (200 OK):** `{ "success": true, "message": "Logged out successfully" }`

---

## 2. Users

### GET `/users/me`
- **Description:** Get the authenticated user's profile.
- **Output (200 OK):**
  ```json
  {
    "success": true,
    "data": { "id": "uuid", "name": "string", "email": "string" }
  }
  ```

---

## 3. Workspaces

### POST `/workspaces`
- **Description:** Create a new workspace.
- **Input (JSON):**
  ```json
  {
    "name": "string (1-120 chars)"
  }
  ```
- **Output (201 Created):** Workspace object.

### GET `/workspaces`
- **Description:** List all workspaces owned by the user.
- **Output (200 OK):** Array of Workspace objects.

### GET `/workspaces/:workspaceId`
- **Description:** Get details of a specific workspace.
- **Output (200 OK):** Workspace object.

---

## 4. Bots

### POST `/workspaces/:workspaceId/bots`
- **Description:** Create a new bot within a workspace.
- **Input (JSON):**
  ```json
  {
    "name": "string (1-120 chars)",
    "description": "string (optional, max 2000 chars)"
  }
  ```
- **Output (201 Created):** Bot object.

### GET `/workspaces/:workspaceId/bots`
- **Description:** List all bots in a specific workspace.
- **Output (200 OK):** Array of Bot objects.

### GET `/bots/:botId`
- **Description:** Get details of a specific bot.
- **Output (200 OK):** Bot object.

### PATCH `/bots/:botId`
- **Description:** Update a bot's name, description, or active/paused state.
- **Input (JSON):** Provide at least one field to update.
  ```json
  {
    "name": "string (optional)",
    "description": "string (optional, can be null to clear)",
    "isActive": "boolean (optional) — false pauses the bot"
  }
  ```
- **Output (200 OK):** Updated Bot object. A paused bot short-circuits before any AI call: it answers with a fixed "paused" message and does not escalate.

### DELETE `/bots/:botId`
- **Description:** Delete a bot. This will also cascade delete all its conversations and knowledge in Postgres, and delete its embeddings in the AI Vector Store.
- **Output (200 OK):** `{ "success": true }`

### PATCH `/bots/:botId/model`
- **Description:** Assign a bot's primary and/or fallback catalog model, or clear either. Requires `bots:manage` (OWNER or ADMIN) — the same permission as renaming a bot, deliberately reused; an AGENT receives **403**.
- **Input (JSON):** Provide at least one field.
  ```json
  {
    "aiModelId": "uuid of a catalog model, or null to clear",
    "fallbackAiModelId": "uuid of a catalog model, or null to clear"
  }
  ```
- **Notes:** Each id is an **internal catalog uuid**, not a provider model id. A provider-native id such as `openai/gpt-4o` fails validation with **400** before any permission check runs, so it is a 400 for every role. An unknown model is 400; a **disabled** model, or a model whose provider is disabled, is 400. Sending `null` skips validation entirely and is always permitted — `null` means "use the platform default" (primary) or "no failover" (fallback). The fallback must differ from the primary (400 otherwise).
- **Output (200 OK):** Updated Bot object, including `aiModel` and `fallbackAiModel` — neither contains the provider-native id.

---

## 4b. Bot Configuration

All configuration routes require `bots:manage` for writes and `bots:view` for reads (OWNER/ADMIN only; an AGENT holds neither). The configuration is a complete object on every read: a bot with no stored row resolves to the documented defaults. `version` is optimistic-concurrency control — it stores no history.

### GET `/bots/:botId/config`
- **Output (200 OK):** `{ config, effective, version, updatedAt }`. `effective` reports the parameters actually applied after filtering by the serving model's capabilities (`appliedParams`, `ignoredParams`), whether the fallback is serving (`modelPromoted`), whether no model is usable (`modelUnavailable`), and whether knowledge is active (`knowledgeActive`).

### PATCH `/bots/:botId/config`
- **Input (JSON):** Any subset of the configuration columns, plus the required `expectedVersion`:
  ```json
  {
    "expectedVersion": 4,
    "welcomeMessage": "Hi! Ask me anything.",
    "temperature": 0.2
  }
  ```
- **Errors:** **400** validation (field bounds, cross-field invariants, sentinel in `customInstructions`); **409** version conflict, returning the current `{ config, effective, version, updatedAt }` in the body so the client can merge.
- **Output (200 OK):** Same shape as GET.

### POST `/bots/:botId/config/reset`
- **Input (JSON):** `{ "section": "general|personality|conversation|knowledge|humanSupport|generation|appearance|all", "expectedVersion": 4, "includeAvatar": false }`.
- **Notes:** Writes defaults for the named section only. The avatar is cleared only when `includeAvatar: true` and the section is `appearance`/`all` — deleting an uploaded image as a side effect is destructive.
- **Output (200 OK):** Same shape as GET.

### POST `/bots/:botId/config/preview`
- **Description:** Test a **draft** configuration against the bot's real knowledge base. Persists nothing. Models are resolved from the bot's stored ids, never from the draft.
- **Input (JSON):** `{ "message": "string", "draft": ResolvedBotConfig }` (the full grouped config).
- **Output (200 OK):** `{ response, fallback_required, reason?, sources?, appliedParams, ignoredParams }`.
- **Notes:** Gated on `bots:manage` — it is a real provider call, so it is not free inference. It deliberately does **not** expose the pipeline debug trace.

### POST `/bots/:botId/avatar`
- **Description:** Upload an avatar (`multipart/form-data`, field `avatar`). PNG/JPEG/WebP, ≤ 512 KB, magic-byte verified.
- **Output (201 Created):** `{ avatarUrl, avatarUpdatedAt, avatarVersion }`.

### DELETE `/bots/:botId/avatar`
- **Output (200 OK):** Clears the avatar and bumps `avatarVersion`.

### GET `/bots/:botId/avatar`
- **Description:** Serve the avatar bytes. Authenticated, `Cache-Control: private`, supports `ETag`/`304`. Returns the image itself, not the JSON envelope.

---

## 5. Knowledge (FAQs / RAG Data)

### POST `/bots/:botId/knowledge`
- **Description:** Add a new knowledge entry for a bot. Triggers AI classification and Python ingestion into VectorDB.
- **Input (JSON):**
  ```json
  {
    "title": "string (optional, max 200)",
    "category": "string (optional, max 120)",
    "question": "string (required, max 2000)",
    "answer": "string (required, max 10000)"
  }
  ```
- **Output (201 Created):** KnowledgeEntry object.

### GET `/bots/:botId/knowledge`
- **Description:** List all knowledge entries for a bot.
- **Output (200 OK):** Array of KnowledgeEntry objects.

### DELETE `/bots/:botId/knowledge`
- **Description:** Delete ALL knowledge entries for a specific bot from Postgres and VectorDB.
- **Output (200 OK):** `{ "success": true }`

### PATCH `/knowledge/:knowledgeId`
- **Description:** Update a specific knowledge entry.
- **Input (JSON):**
  ```json
  {
    "title": "string (optional)",
    "category": "string (optional)",
    "question": "string (optional)",
    "answer": "string (optional)"
  }
  ```
- **Output (200 OK):** Updated KnowledgeEntry object.

### DELETE `/knowledge/:knowledgeId`
- **Description:** Delete a specific knowledge entry.
- **Output (501 Not Implemented):** Deleting single knowledge entries is coming soon. Use delete all.

---

## 6. Conversations & Messaging

### POST `/bots/:botId/conversations`
- **Description:** Start a new conversation with a bot.
- **Output (201 Created):** Conversation object (contains `id`, `botId`, `status`, `assignedAgentId`).

### GET `/bots/:botId/conversations`
- **Description:** List all conversations under a bot.
- **Output (200 OK):** Array of Conversation objects.

### GET `/conversations/:conversationId`
- **Description:** Get a conversation, including its chronologically ordered messages, each message's feedback (if any), and the collected `contact` details. Requires `conversations:view`.
- **Output (200 OK):** Conversation object including `messages` and `contact`.

### POST `/conversations/:conversationId/messages`
- **Description:** Send a message to the bot. This queries the Python AI service with the bot's resolved configuration. Node then applies the human-support policy: with fallback ON an unanswerable turn escalates to `WAITING_FOR_HUMAN` (recording the reason and whether it was outside business hours); with fallback OFF the conversation stays `ACTIVE` and the owner's fallback message is shown. Requires `conversations:reply`.
- **Input (JSON):**
  ```json
  {
    "content": "string (required, max 4000)"
  }
  ```
- **Output (201 Created):**
  ```json
  {
    "success": true,
    "data": {
      "userMessage": { "id": "uuid", "role": "USER", "content": "..." },
      "assistantMessage": { "id": "uuid", "role": "ASSISTANT", "content": "...", "sources": null },
      "ai": { "answer": "string", "intent": "string", "confidence": 0.9, "fallback_required": false },
      "sources": [ { "chunkId": "uuid", "sourceId": "uuid", "topic": "string", "pageNumber": 2, "label": "handbook.pdf" } ],
      "escalation": { "required": true, "offHours": false, "acceptanceMessage": "A teammate will pick this up shortly." }
    }
  }
  ```
- **Notes:** `sources` is present only when the bot's `knowledge.showSources` is on and the turn produced an answer. `escalation` is present when the turn escalated or produced an acceptance line. The AI-service-only fields `model_used`/`failover_used` are logged by Node and **never** forwarded to the browser.

### POST `/conversations/:conversationId/messages/:messageId/feedback`
- **Description:** Rate an assistant message. Requires `conversations:reply`.
- **Input (JSON):** `{ "rating": "UP|DOWN", "reason"?: "INACCURATE|NOT_HELPFUL|WRONG_SOURCE|INCOMPLETE|OTHER", "comment"?: "string (max 1000)" }`.
- **Notes:** One row per message (`upsert`). A USER message is **400**; a message in another conversation is **404**; feedback disabled for the bot is **409**.

### DELETE `/conversations/:conversationId/messages/:messageId/feedback`
- **Description:** Remove a rating. Requires `conversations:reply`. 404 when there is nothing to remove.

### POST `/conversations/:conversationId/contact`
- **Description:** Record contact details a customer supplied. Requires `conversations:reply`.
- **Input (JSON):** `{ "name"?, "email"?, "phone"?, "orderId"? }` — only fields the bot's `contactCollection.fields` lists are accepted (400 otherwise), and configured `required` fields must be present (400). Collection disabled is **409**.
- **Notes:** Per-conversation PII. Never returned on the conversation **list** endpoint, never logged by value.

---

## 7. Admin AI Operations (Testing/Debug)

*These endpoints proxy requests directly to the Python AI service.*

- **POST `/admin/ai/classify`**: Test the intent classifier with a given text payload.
- **GET `/admin/ai/status`**: View operational status of the AI service.
- **GET `/admin/ai/ml-status`**: View ML model load status and capabilities.
- **GET `/admin/ai/ml-evaluate`**: Trigger model evaluation metrics.
- **POST `/admin/ai/rag/search`**: Perform raw vector similarity search.
- **POST `/admin/ai/debug/chat-pipeline`**: Run full chat pipeline returning execution traces.
- **GET `/admin/ai/testing/status`**: System status across VectorDB, ML, and LLM.
- **GET `/admin/ai/vector-stats`**: Postgres pgvector health and index stats.

---

## 8. AI Model Catalog

Two audiences. `GET /ai/models` is how a client renders a model selector; the `/platform/*`
routes are how a platform owner curates what that selector offers. **No credential ever crosses
this boundary** — the server holds no provider credential, and readiness is reported as
booleans, never as a masked string.

### GET `/ai/models`
- **Description:** The catalog as a workspace sees it — **enabled models of enabled providers**. Authenticated, but deliberately unscoped: the list is identical for every caller and contains no tenant data.
- **Output (200 OK):** Array of `{ id, displayName, provider: { slug, name } }`.
- **Notes:** `providerModelId` is deliberately **absent**. Workspaces select by internal uuid; returning the native id would invite a client to call the provider directly, which is the catalog bypass this API exists to prevent.

### GET `/platform/providers`
- **Auth:** `PLATFORM_OWNER` only (403 for every other role).
- **Output (200 OK):** Every provider with `modelCount`, `enabledModelCount`, and the two readiness axes:
  - `adapterAvailable` — the AI service has a Python adapter for this slug.
  - `credentialConfigured` — that adapter reports its credential is present.
- **Notes:** The axes are reported **separately** (a missing adapter is a deployment problem; a missing credential is a configuration problem — different remedies). Both are `null` — "unknown", never `false` — when the AI service is unreachable. **No live provider call is made**; readiness is configuration state, not reachability.

### PATCH `/platform/providers/:providerId`
- **Auth:** `PLATFORM_OWNER` only.
- **Input (JSON):** `{ "name"?, "description"?, "enabled"? }` — at least one field.
- **Notes:** `slug` is immutable: the schema is `.strict()`, so sending it is a **400**, not a silent strip. Disabling a provider mutates **no** model rows, so re-enabling restores the exact prior per-model selection.
- **Output (200 OK):** Updated provider view.

### GET `/platform/models`
- **Auth:** `PLATFORM_OWNER` only.
- **Query:** `?providerId=<uuid>&enabled=true|false` (both optional).
- **Output (200 OK):** Every model in any state, each with `providerModelId`, its resolved provider, and a live `botCount`.

### POST `/platform/models`
- **Auth:** `PLATFORM_OWNER` only.
- **Input (JSON):**
  ```json
  {
    "providerId": "uuid (required)",
    "providerModelId": "string (required, no whitespace) — the provider's own id",
    "displayName": "string (required, max 120)",
    "enabled": false
  }
  ```
- **Notes:** This is the **only** request in the API that writes `providerModelId`, and it writes it once. `enabled` defaults to **false**, so cataloguing never silently changes platform behaviour. A duplicate `(providerId, providerModelId)` is **409**. A wrong `providerModelId` is not detectable here — Node holds no provider credential and makes no provider calls — so it surfaces at chat time as `MODEL_UNAVAILABLE`.
- **Output (201 Created):** Model view.

### PATCH `/platform/models/:modelId`
- **Auth:** `PLATFORM_OWNER` only.
- **Input (JSON):** `{ "displayName"?, "enabled"? }` — at least one field.
- **Notes:** `providerModelId` is **immutable**: the schema is `.strict()`, so sending it is a **400**. Correcting a wrong id is delete-and-recreate, which is safe because deletion is blocked while the model is in use.
- **Output (200 OK):** Updated model view.

### DELETE `/platform/models/:modelId`
- **Auth:** `PLATFORM_OWNER` only.
- **Notes:** Refused with **409** while any bot references the model. Two independent mechanisms enforce this: the service's bot-count check (which produces the actionable message) and the `onDelete: Restrict` foreign key (the actual guarantee, which holds even if the check is bypassed or raced).
- **Output (200 OK):** `{ "success": true }`.

> **Attribution.** Every successful catalog mutation emits exactly **one** structured log record naming the actor, the action, and the target — the interim control, since v1 has no audit table and no audit endpoint. A denied or rejected request logs nothing, because nothing changed. The record carries the catalog's own uuid, never a credential or a provider-native id.

---

## 9. Knowledge Sources (Uploaded Documents)

A bot's knowledge comes from two places: hand-written FAQ entries (section 5) and uploaded
documents, which are the subject of this section. An upload is a **batch** — one or more
files in the `files` field — and each file produces its own outcome, so one bad file never
discards the work done on its siblings.

Every upload limit is a **runtime platform setting**, resolved per request from
`platform_settings` and never cached in a module-level parser. See section 11.

### POST `/bots/:botId/knowledge-sources/upload`
- **Auth:** `documents:manage` on the bot's workspace.
- **Description:** Upload one or more PDF/DOCX documents. Each file is extracted, chunked, embedded, and stored as vectors; a `KnowledgeSource` row and its `KnowledgeChunk` rows mirror the result in Postgres.
- **Input (multipart/form-data):**

  | Part | Type | Notes |
  |------|------|-------|
  | `files` | file (repeated 1..`maxUploadFilesPerRequest`) | The documents. |
  | `topic` | string (optional) | Applied to every chunk of every file in the batch. |

- **Output (201 Created):**
  ```json
  {
    "success": true,
    "message": "Documents uploaded",
    "data": {
      "results": [
        { "filename": "handbook.pdf", "outcome": "PROCESSED", "sourceId": "uuid", "chunksCreated": 42 },
        { "filename": "broken.pdf",   "outcome": "FAILED", "sourceId": "uuid", "error": "PDF contains no extractable text" }
      ],
      "summary": { "total": 2, "processed": 1, "failed": 1, "rejected": 0 }
    }
  }
  ```
- **Outcomes:** `PROCESSED` (row + vectors written), `FAILED` (row written with `status: FAILED` and an `errorMessage`, no vectors), `REJECTED` (file never entered the pipeline — **no row is created**).
- **Status codes:**
  - **201** — at least one file entered the pipeline (`processed + failed > 0`). A `FAILED` file is still a 201.
  - **400** — every file was rejected. The same `{ results, summary }` shape arrives under `details`.
  - **400** — a request-level violation before any file is touched: more files than `maxUploadFilesPerRequest`, combined size over `maxUploadTotalBytes`, or the bot over `maxChunksPerBot`. `error` names the resolved limit.
  - **403** — the caller lacks `documents:manage`. The permission guard runs **before** multer, so the request body is never buffered into memory.
  - **413** — reserved for the legacy single-file route below. The batch route never answers 413: an oversized file here is a per-file `REJECTED`.

### GET `/bots/:botId/knowledge-sources/upload-limits`
- **Auth:** `documents:view` (an AGENT who renders the upload UI is exactly the intended caller).
- **Description:** The resolved limits, for the client's pre-flight checks. The client is never authoritative — a crafted request bypasses it — but it needs the numbers to render "up to N files, X MB each" without a round trip.
- **Output (200 OK):** `{ maxFileSizeBytes, maxFilesPerRequest, maxTotalBytes, maxChunksPerSource, maxChunksPerBot, acceptedExtensions, acceptedMimeTypes }`.
- **Notes:** `aiServiceMaxFileSizeBytes` is deliberately **not** included — it is an internal backstop between the two services, not a limit this tier advertises.

### GET `/bots/:botId/knowledge-sources`
- **Auth:** `documents:view`.
- **Description:** List a bot's document sources.
- **Query:** `status` (optional, one of the `KnowledgeSourceStatus` enum values — `REJECTED` is not accepted, since it is never persisted), `page` (default 1), `limit` (default 20, max 100).
- **Output (200 OK):** `{ sources: [...], pagination: { page, limit, total, totalPages } }`. Each source carries `enabledChunks` / `disabledChunks` counts, derived from one grouped query over its chunks.

### GET `/knowledge-sources/:sourceId`
- **Auth:** `documents:view` (scope resolved from the source → bot → workspace).
- **Output (200 OK):** Source object with `enabledChunks` and `disabledChunks`.
- **Errors:** **404** for a non-member, identical to a missing source (tenant-blindness).

### DELETE `/knowledge-sources/:sourceId`
- **Auth:** `documents:manage`.
- **Description:** Delete a source, its chunk rows, and its vectors.
- **Notes:** The **vectors are deleted before the row**. Prisma's cascade cannot reach them — they live in a different database — so a row-first delete whose vector call failed would leave vectors nothing can enumerate: unreachable, undeletable, and still retrievable. A **409** refuses a source still in `PROCESSING`, because deleting it would race the in-flight ingestion.
- **Output (200 OK):** `{ "success": true, "message": "Source and 42 chunks deleted" }`.

### POST `/bots/:botId/knowledge/upload-document` (legacy)
- **Auth:** `documents:manage`.
- **Description:** The original single-file upload, kept at its URL with its original contract so existing clients keep working.
- **Input (multipart/form-data):** `file` (one file, PDF/DOCX), `bot_id` is taken from the path, `topic` optional.
- **Output (201 Created):** The AI service's ingestion result.
- **Notes:** Unlike the batch route, this path writes **no** `knowledge_sources` row — the document is never listed in the dashboard and never counted against the chunk quota. Its size limit is the resolved `maxUploadFileSizeBytes`, and an oversized file is a **413** quoting that limit. A file of a type the platform does not accept is a **400** and the request body is discarded without being handled.

---

## 10. Knowledge Chunks & Retrieval Testing

Individual chunks are the user-manageable units of document knowledge. A chunk's row id is
shared with its pgvector row, so the two stores are joined by id and nothing else.

### GET `/bots/:botId/knowledge-chunks`
- **Auth:** `knowledge:view`.
- **Query:** `search` (optional substring match on content; an empty value means "no filter" rather than a 400), `sourceId` (optional uuid), `enabled` (`true` / `false`), `page` (default 1), `limit` (default 20, max 100).
- **Output (200 OK):** `{ chunks: [...], pagination: { page, limit, total, totalPages } }`.

### GET `/bots/:botId/knowledge-chunks/stats`
- **Auth:** `knowledge:view`.
- **Output (200 OK):** Per-source counts and status. `disabled` is derived as `total - enabled`, so the three numbers cannot disagree.

### GET `/knowledge-chunks/:chunkId`
- **Auth:** `knowledge:view` (scope resolved from the chunk → bot → workspace).
- **Output (200 OK):** The chunk with its source's details.
- **Errors:** **404** for another workspace's chunk or a non-member; **400** for a non-uuid id, before any query runs.

### PATCH `/knowledge-chunks/:chunkId`
- **Auth:** `knowledge:manage`.
- **Input (JSON):** `content` (optional, trimmed, 1–10 000 chars) and/or `enabled` (optional boolean). At least one is required.
- **Output (200 OK):** The updated chunk, including its new `version` and embedding metadata.
- **Notes:** A content change re-embeds through the AI service. The vector is written **before** the row, so a failure cannot leave the two disagreeing; the response is then a **502** and the chunk still holds its previous content. An `enabled`-only change toggles without re-embedding and without bumping the version.

### DELETE `/knowledge-chunks/:chunkId`
- **Auth:** `knowledge:manage`.
- **Notes:** The vector is deleted first, then the row. A 404 from the AI service (vector already gone) is absorbed and the row is deleted anyway — otherwise the row would be permanently undeletable. Any other failure aborts and keeps the row, because the vector may still exist. Deleting a source's last chunk leaves the source in place.
- **Output (200 OK):** `{ "success": true, "message": "Chunk deleted" }`.

### POST `/bots/:botId/knowledge-chunks/bulk`
- **Auth:** `knowledge:manage`.
- **Input (JSON):**
  ```json
  { "action": "enable" | "disable" | "delete", "chunkIds": ["uuid", "..."] }
  ```
- **Notes:** 1–100 ids. The whole batch is refused with **400** if any id belongs to another bot — the ownership check runs against this bot before anything changes, so a partial application is impossible. Duplicate ids are collapsed rather than failing the check.
- **Output (200 OK):** `{ "success": true, "affected": 12 }`.

### POST `/bots/:botId/knowledge-chunks/test` (retrieval testing)
- **Auth:** `knowledge:view` — reading knowledge is what this does, so an AGENT who can see the knowledge can try it.
- **Input (JSON):** `query` (required, 1–1000 chars), `topK` (default 5, max 20).
- **Description:** Run a similarity search over the bot's **whole** knowledge base — uploaded documents *and* FAQ entries — and return the hits.
- **Output (200 OK):** The matching chunks with their scores and resolved source filenames. A hit whose `source_id` is not a document source (an FAQ entry) reports `source: null` rather than erroring.
- **Notes:** The same `RAGService` funnel production chat uses, so what the panel shows is what the bot would retrieve. Disabled chunks are excluded at the SQL level (`AND enabled = true`), never by post-filtering. An AI failure is a **502**, not an empty result set — an empty list means "nothing matched", and conflating the two would hide an outage.

---

## 11. Platform Settings (Upload Limits)

- **Auth:** `PLATFORM_OWNER` only (the whole `/platform` namespace is gated in `routes/index.ts`).
- **Description:** The runtime-tunable upload limits every upload route enforces. The values live in a singleton `platform_settings` row, are bounded per field, and are checked against each other after merging — a self-contradictory combination is refused rather than stored.
- **Input (JSON) — `PATCH` accepts any subset:**
  ```json
  {
    "maxUploadFileSizeBytes": 10485760,
    "maxUploadFilesPerRequest": 10,
    "maxUploadTotalBytes": 52428800,
    "maxChunksPerSource": 5000,
    "maxChunksPerBot": 0,
    "aiServiceMaxFileSizeBytes": 104857600
  }
  ```
  | Field | Bounds | Meaning |
  |-------|--------|---------|
  | `maxUploadFileSizeBytes` | 1 MB – 100 MB | One file's size. |
  | `maxUploadFilesPerRequest` | 1 – 50 | Files accepted in one batch. |
  | `maxUploadTotalBytes` | 1 MB – 500 MB | Combined size of one request. |
  | `maxChunksPerSource` | 1 – 50 000 | Embedding spend ceiling per document. |
  | `maxChunksPerBot` | 0 – 1 000 000 | `0` means **unlimited**, not "none allowed". |
  | `aiServiceMaxFileSizeBytes` | 1 MB – 500 MB | Internal backstop at the AI boundary; never advertised to clients. |
- **Output (200 OK):** The stored settings.
- **Status codes:**
  - **400** — an empty body; a value outside its range; or a patch that would put `maxUploadTotalBytes` below `maxUploadFileSizeBytes`, or `aiServiceMaxFileSizeBytes` below it. The message names both conflicting fields.
  - **403** — a signed-in user who is not a platform owner, **including a workspace OWNER**, whose role grants nothing platform-wide.
  - **401** — no token.
- **Notes:** A successful write is visible on the very next read, in every process — the resolver is the only reader of these limits, and the write path invalidates the cache. Validation runs against a fresh read, not the cache, so a stale value cannot slip a contradictory configuration through.

### GET `/platform/settings`
- **Auth:** `PLATFORM_OWNER` only.
- **Output (200 OK):** The stored settings, including `createdAt` / `updatedAt`. The singleton row is created on first read if it is absent, so this is never a 404.

### PATCH `/platform/settings`
- **Auth:** `PLATFORM_OWNER` only.
- **Description:** Change one or more limits. See the field table above.
- **Output (200 OK):** The stored settings after the change.

---

## Generic Error Outputs
If a validation, authentication, or server error occurs, the output will follow this structure:
```json
{
  "success": false,
  "error": "Error message description"
}
```
Validation errors may include an array of issues.

