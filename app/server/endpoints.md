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
- **Description:** Update a bot's name or description.
- **Input (JSON):** Provide at least one field to update.
  ```json
  {
    "name": "string (optional)",
    "description": "string (optional, can be null to clear)"
  }
  ```
- **Output (200 OK):** Updated Bot object.

### DELETE `/bots/:botId`
- **Description:** Delete a bot. This will also cascade delete all its conversations and knowledge in Postgres, and delete its embeddings in the AI Vector Store.
- **Output (200 OK):** `{ "success": true }`

### PATCH `/bots/:botId/model`
- **Description:** Assign a catalog model to a bot, or clear the assignment. Requires `bots:manage` (OWNER or ADMIN) — the same permission as renaming a bot, deliberately reused; an AGENT receives **403**.
- **Input (JSON):**
  ```json
  {
    "aiModelId": "uuid of a catalog model, or null to clear"
  }
  ```
- **Notes:** The id is an **internal catalog uuid**, not a provider model id. A provider-native id such as `openai/gpt-4o` fails validation with **400** before any permission check runs, so it is a 400 for every role. An unknown model is 400; a **disabled** model, or a model whose provider is disabled, is 400. Sending `null` skips validation entirely and is always permitted — `null` means "use the platform default".
- **Output (200 OK):** Updated Bot object, including `aiModel` — which never contains the provider-native id.

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
- **Description:** Get a conversation, including its chronologically ordered messages.
- **Output (200 OK):** Conversation object including an array of `messages`.

### POST `/conversations/:conversationId/messages`
- **Description:** Send a message to the bot. This queries the Python AI service. If the AI requires a human fallback, the conversation `status` is updated to `WAITING_FOR_HUMAN`.
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
      "assistantMessage": { "id": "uuid", "role": "ASSISTANT", "content": "..." },
      "ai": {
        "answer": "string",
        "intent": "string",
        "confidence": 0.9,
        "fallback_required": false
      }
    }
  }
  ```

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

## Generic Error Outputs
If a validation, authentication, or server error occurs, the output will follow this structure:
```json
{
  "success": false,
  "error": "Error message description"
}
```
Validation errors may include an array of issues.
