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

## Generic Error Outputs
If a validation, authentication, or server error occurs, the output will follow this structure:
```json
{
  "success": false,
  "error": "Error message description"
}
```
Validation errors may include an array of issues.
