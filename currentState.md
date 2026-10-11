# AssistIQ — Current State of the Project

> **Generated:** 2026-10-11  
> **Purpose:** A single-file snapshot of everything that has been built, how the pieces connect, and what is explicitly not yet implemented.

---

## 1. Project Overview

AssistIQ is a **multi-tenant, AI-powered customer-support SaaS** platform. Businesses create **Workspaces**, build **Bots**, fill them with **Knowledge** (FAQ entries or uploaded documents), and let those bots answer customer questions in real time through a deterministic RAG pipeline.

The project is structured as a **monorepo** with three independently runnable services under `app/`:

| Service | Stack | Port | Role |
|---------|-------|------|------|
| **Client** | Next.js 16, React 19, Tailwind v4 | `3000` | User-facing dashboard & chat widget |
| **Server** | Node 20, Express 4, Prisma 6, PostgreSQL 16 | `5000` | API orchestrator, auth, business logic, tenant isolation |
| **AI** | Python 3.12, FastAPI, LangChain, pgvector, scikit-learn | `8000` | RAG pipeline, ML classification, LLM generation |

**Communication flow:** Browser → Client (Next.js) → Server (Express) → AI (FastAPI). The browser **never** talks to the AI service directly.

---

## 2. Database & Data Model

### 2.1 Relational Database (PostgreSQL 16 via Prisma)

The schema lives in `app/server/prisma/schema.prisma` and includes **5 applied migrations**:

| Migration | What It Does |
|-----------|-------------|
| `0_init` | Base schema: users, workspaces, bots, knowledge_entries, conversations, messages |
| `20261002141705_init_rbac` | Adds `PlatformRole`, `WorkspaceRole` enums, `users.platformRole`, `workspace_members` table |
| `20261002181628_add_ai_model_catalog` | Adds `ai_providers`, `ai_models` tables; nullable `bots.aiModelId` with `onDelete: Restrict` |
| `20261003170937_add_knowledge_management` | Adds `KnowledgeSource`, `KnowledgeChunk`, `PlatformSetting` models for document knowledge |
| `20261004170014_add_bot_configuration` | Adds `BotConfiguration` (1:1 per bot), `MessageFeedback`, `ConversationContact`, plus all personality/tone/business-hours enums |

### 2.2 Entity Hierarchy

```
User ──owns──▶ Workspace ──has──▶ Bot ──has──▶ KnowledgeEntry (FAQ)
                   │                  ├─has──▶ KnowledgeSource ──has──▶ KnowledgeChunk (documents)
                   │                  ├─has──▶ Conversation ──has──▶ Message
                   │                  │            ├─has──▶ ConversationContact
                   │                  │            └─has──▶ MessageFeedback
                   │                  ├─refs──▶ AIModel (primary)
                   │                  ├─refs──▶ AIModel (fallback)
                   │                  └─has──▶ BotConfiguration (1:1)
                   └──has──▶ WorkspaceMember (RBAC)

AIProvider ──has──▶ AIModel (platform catalog)
PlatformSetting (singleton row)
```

### 2.3 Key Models Implemented

| Model | Table | Key Fields |
|-------|-------|-----------|
| `User` | `users` | id, name, email, passwordHash, platformRole (USER/PLATFORM_OWNER) |
| `Workspace` | `workspaces` | id, name, ownerId |
| `WorkspaceMember` | `workspace_members` | userId, workspaceId, role (OWNER/ADMIN/AGENT) |
| `Bot` | `bots` | id, name, description, workspaceId, aiModelId, fallbackAiModelId, isActive |
| `BotConfiguration` | `bot_configurations` | personality, tone, customPersonality, customInstructions, responseLanguage, responseLength, welcomeMessage, conversationStarter, suggestedQuestions, feedbackEnabled, knowledgeStrictness, showSources, retrievalTopK, temperature, topP, maxOutputTokens, humanFallbackEnabled, fallbackMessage, humanRequestBehavior, businessHours, contactCollection, avatarData, version |
| `KnowledgeEntry` | `knowledge_entries` | id, title, category, question, answer, botId |
| `KnowledgeSource` | `knowledge_sources` | id, botId, filename, mimeType, fileSizeBytes, status (PENDING/PROCESSING/PROCESSED/FAILED), pagesExtracted, chunksCreated, topic |
| `KnowledgeChunk` | `knowledge_chunks_meta` | id, sourceId, botId, content, chunkIndex, pageNumber, section, topic, enabled, version, embeddingModel, embeddingDimension |
| `Conversation` | `conversations` | id, botId, status (ACTIVE/WAITING_FOR_HUMAN/RESOLVED), assignedAgentId, escalatedAt, escalationReason, escalatedOffHours |
| `Message` | `messages` | id, conversationId, role (USER/ASSISTANT/SYSTEM), content, sources (JSON) |
| `MessageFeedback` | `message_feedback` | messageId, conversationId, rating (UP/DOWN), reason, comment |
| `ConversationContact` | `conversation_contacts` | conversationId, name, email, phone, orderId |
| `AIProvider` | `ai_providers` | id, slug, name, description, enabled |
| `AIModel` | `ai_models` | id, providerId, providerModelId, displayName, enabled, capabilities (JSON) |
| `PlatformSetting` | `platform_settings` | singleton row with upload limits, chunk limits |

### 2.4 Vector Database (pgvector on port 5433)

Separate PostgreSQL instance with the `vector` extension. The AI service manages a `knowledge_chunks` table containing embeddings. Row IDs are shared with the Prisma `KnowledgeChunk` model for cross-store joins.

---

## 3. Server (Express Backend) — Implemented Features

### 3.1 Authentication

- **Registration** (`POST /api/v1/auth/register`) — name, email, password (≥8 chars), returns JWT + user profile
- **Login** (`POST /api/v1/auth/login`) — generic "Invalid email or password" for both unknown email and wrong password
- **Logout** (`POST /api/v1/auth/logout`) — client-side only (stateless JWT)
- **JWT middleware** — Bearer token verification on all protected routes
- **Password hashing** — bcryptjs with 12 salt rounds
- **Rate limiting** — 20 requests / 15 minutes per IP on auth routes

### 3.2 Authorization (RBAC) — Fully Implemented

**Two independent authorization domains:**

| Domain | Roles | Scope |
|--------|-------|-------|
| **Platform** | `USER`, `PLATFORM_OWNER` | Global — AI lab, model catalog, platform admin |
| **Workspace** | `OWNER`, `ADMIN`, `AGENT` | Per-workspace — bots, knowledge, conversations |

**Permission matrix:**

| Role | Can | Cannot |
|------|-----|--------|
| `OWNER` | Everything including `members:manage` | — |
| `ADMIN` | Manage bots, knowledge, documents; reply/resolve/assign conversations | Manage members, update/delete workspace |
| `AGENT` | Read workspace/knowledge, reply to and resolve conversations | View/manage bots, manage knowledge, manage members |

**Denial semantics:**
- No membership → `404` (never `403`, never leaks resource existence)
- Member lacking permission → `403`
- Not authenticated → `401`

**Implementation:**
- Middleware: `requireWorkspacePermission(permission, scope)` and `requirePlatformOwner()`
- Routes resolve workspace ID from bot, knowledge, or conversation params
- Platform role is re-read from DB (not JWT), so promotions apply immediately

### 3.3 Multi-Tenant Ownership Model

- Ownership enforced **in the service layer** via single Prisma queries with embedded ownership joins
- Cross-tenant IDs return `null` → `404` (never `403`)
- Creating child resources first asserts ownership of the parent
- Owner ID always from verified token, never from request body
- Cascading deletes via Prisma `onDelete: Cascade`

### 3.4 Workspace Management

| Endpoint | Status |
|----------|--------|
| `POST /api/v1/workspaces` | ✅ Create workspace |
| `GET /api/v1/workspaces` | ✅ List caller's workspaces |
| `GET /api/v1/workspaces/:workspaceId` | ✅ Get single workspace |

### 3.5 Workspace Members

| Endpoint | Status |
|----------|--------|
| `GET /workspaces/:workspaceId/members` | ✅ List members |
| `POST /workspaces/:workspaceId/members` | ✅ Add member (OWNER only) |
| `PATCH /workspaces/:workspaceId/members/:memberId` | ✅ Update role |
| `DELETE /workspaces/:workspaceId/members/:memberId` | ✅ Remove member |

### 3.6 Bot Management

| Endpoint | Status |
|----------|--------|
| `POST /workspaces/:workspaceId/bots` | ✅ Create bot |
| `GET /workspaces/:workspaceId/bots` | ✅ List workspace bots |
| `GET /bots/:botId` | ✅ Get bot details |
| `PATCH /bots/:botId` | ✅ Update bot |
| `PATCH /bots/:botId/model` | ✅ Assign/clear AI model |
| `DELETE /bots/:botId` | ✅ Delete (cascades knowledge/conversations) |

**Bot configuration endpoints:**
| Endpoint | Status |
|----------|--------|
| `GET /bots/:botId/config` | ✅ Get resolved config (defaults merged) |
| `PATCH /bots/:botId/config` | ✅ Update config (partial, optimistic concurrency) |
| `DELETE /bots/:botId/config` | ✅ Reset to defaults |
| `GET /bots/:botId/config/preview` | ✅ Preview system prompt |
| `PUT /bots/:botId/avatar` | ✅ Upload avatar |
| `GET /bots/:botId/avatar` | ✅ Serve avatar (with ETag caching) |
| `DELETE /bots/:botId/avatar` | ✅ Remove avatar |

### 3.7 Knowledge Management (FAQ)

| Endpoint | Status |
|----------|--------|
| `POST /bots/:botId/knowledge` | ✅ Create FAQ entry (syncs to AI service) |
| `GET /bots/:botId/knowledge` | ✅ List entries |
| `PATCH /knowledge/:knowledgeId` | ✅ Update entry |
| `DELETE /knowledge/:knowledgeId` | ✅ Delete entry |

### 3.8 Document Knowledge (Sources & Chunks)

| Endpoint | Status |
|----------|--------|
| `POST /bots/:botId/knowledge/sources/upload` | ✅ Multi-file upload (PDF/DOCX) with validation |
| `GET /bots/:botId/knowledge/sources` | ✅ List sources |
| `GET /knowledge/sources/:sourceId` | ✅ Get source detail |
| `DELETE /knowledge/sources/:sourceId` | ✅ Delete source + chunks |
| `DELETE /bots/:botId/knowledge/all` | ✅ Delete all knowledge (FAQ + sources + chunks) |
| `GET /bots/:botId/knowledge/chunks` | ✅ List chunks (paginated, filterable) |
| `GET /knowledge/chunks/:chunkId` | ✅ Get chunk detail |
| `PATCH /knowledge/chunks/:chunkId` | ✅ Edit chunk content (triggers re-embedding) |
| `PATCH /knowledge/chunks/:chunkId/toggle` | ✅ Enable/disable chunk |

**Upload pipeline:** Validates file types, sizes, and counts against `PlatformSetting` limits → extracts text → chunks → embeds → stores in pgvector.

### 3.9 Conversations & Messages

| Endpoint | Status |
|----------|--------|
| `POST /bots/:botId/conversations` | ✅ Create conversation |
| `GET /bots/:botId/conversations` | ✅ List conversations |
| `GET /conversations/:conversationId` | ✅ Get conversation with messages |
| `POST /conversations/:conversationId/messages` | ✅ Send message → AI pipeline → store response |
| `PATCH /conversations/:conversationId/status` | ✅ Update status (resolve/reopen) |

**Chat orchestration flow:** Verify ownership → store USER message → call `aiServiceClient.chat()` → flip to `WAITING_FOR_HUMAN` on fallback → store ASSISTANT message → return both + AI metadata.

### 3.10 Message Feedback

| Endpoint | Status |
|----------|--------|
| `POST /messages/:messageId/feedback` | ✅ Submit thumbs up/down with reason |
| `PATCH /messages/:messageId/feedback` | ✅ Update existing feedback |
| `DELETE /messages/:messageId/feedback` | ✅ Remove feedback |

### 3.11 Conversation Contacts

| Endpoint | Status |
|----------|--------|
| `POST /conversations/:conversationId/contact` | ✅ Submit contact details |
| `GET /conversations/:conversationId/contact` | ✅ Retrieve contact |

### 3.12 AI Model Catalog

**Workspace-facing:**
| Endpoint | Status |
|----------|--------|
| `GET /ai/models` | ✅ Enabled models of enabled providers (no providerModelId exposed) |

**Platform-owner-facing:**
| Endpoint | Status |
|----------|--------|
| `GET /platform/providers` | ✅ All providers with adapter readiness + model counts |
| `PATCH /platform/providers/:providerId` | ✅ Update provider (name, description, enabled) |
| `GET /platform/models` | ✅ All models with filters (?providerId, ?enabled) |
| `POST /platform/models` | ✅ Create model (disabled by default) |
| `PATCH /platform/models/:modelId` | ✅ Update model (displayName, enabled) |
| `DELETE /platform/models/:modelId` | ✅ Delete (409 if referenced by a bot) |

**Key behaviors:**
- `providerModelId` and `slug` are write-once (PATCH rejects them with 400)
- New models created disabled; selectable only when both model and provider are enabled
- Provider readiness is reported as two independent nullable booleans (adapter available + credential configured)
- No credential ever crosses this boundary

### 3.13 Platform Administration

| Endpoint | Status |
|----------|--------|
| `GET /platform/settings` | ✅ Get upload/chunk limits |
| `PATCH /platform/settings` | ✅ Update limits |
| `GET /platform/users` | ✅ List all platform users |
| `GET /platform/workspaces` | ✅ List all workspaces |
| `GET /platform/system` | ✅ System overview stats |

### 3.14 AI Admin / Lab (Proxied to AI Service)

| Endpoint | Status |
|----------|--------|
| `GET /admin/ai/status` | ✅ AI service status + provider adapters |
| `GET /admin/ai/ml/status` | ✅ ML model status |
| `GET /admin/ai/ml/evaluate` | ✅ Classifier evaluation metrics |
| `GET /admin/ai/system` | ✅ System-wide status |
| `GET /admin/ai/vector-store/stats` | ✅ Vector store statistics |
| `POST /admin/ai/debug/chat-pipeline` | ✅ Detailed pipeline debug |

### 3.15 Bot Model Resolution & Fallback

- Bots can have a **primary model** and a **fallback model** assigned
- Conversation service resolves `providerModelId` + provider slug and sends to AI service
- Bot with no model assigned → AI service uses its environment default
- Model failover: primary fails → fallback attempted → environment default as last resort
- Escalation policy service determines behavior based on bot configuration

### 3.16 Business Hours

- Configurable per-bot business hours with timezone support
- Windows defined per day-of-week with start/end times
- After-hours behavior options: `MESSAGE_ONLY`, `MESSAGE_AND_ESCALATE`, `ESCALATE`

### 3.17 Security

- `helmet` security headers
- Configurable CORS (allowlist or `*`)
- JSON body size limits
- Structured logging with credential redaction (Authorization headers, passwords, API keys)
- Error handler never returns stack traces, DB internals, or secrets in production
- AI service authenticated via `X-API-Key` header

### 3.18 Services Layer

22 service files implementing all business logic:

| Service | Purpose |
|---------|---------|
| `auth.service.ts` | Registration, login |
| `user.service.ts` | User profile |
| `workspace.service.ts` | Workspace CRUD |
| `workspaceMember.service.ts` | Member management |
| `bot.service.ts` | Bot CRUD |
| `botConfig.service.ts` | Bot configuration management with defaults merging |
| `botModelResolver.ts` | Primary/fallback model resolution |
| `knowledge.service.ts` | FAQ CRUD + AI sync |
| `knowledgeSource.service.ts` | Document upload + ingestion lifecycle |
| `knowledgeChunk.service.ts` | Chunk management + re-embedding |
| `conversation.service.ts` | Chat orchestration |
| `conversationContact.service.ts` | Contact details |
| `messageFeedback.service.ts` | Feedback management |
| `aiServiceClient.ts` | Sole AI service communication boundary |
| `aiCatalog.service.ts` | Model catalog management |
| `authorization.service.ts` | Role/permission checks |
| `avatar.service.ts` | Avatar upload/serve with ETag caching |
| `businessHours.ts` | Business hours evaluation |
| `escalationPolicy.ts` | Escalation behavior decisions |
| `platform.service.ts` | Platform admin queries |
| `platformSettings.service.ts` | Upload/chunk limits management |
| `sourceLabels.ts` | Source reference labeling |

---

## 4. AI Service (FastAPI) — Implemented Features

### 4.1 Deterministic Hybrid Pipeline

```
message ─▶ 1. CLASSIFY   TF-IDF + LogisticRegression intent classifier
         ─▶ 2. ROUTE      high confidence → topic-filtered search; else full search
         ─▶ 3. RETRIEVE   pgvector cosine similarity, top_k configurable, scoped to bot_id
         ─▶ 4. VALIDATE   zero results → fallback (NO_RELEVANT_KNOWLEDGE)
         ─▶ 5. GENERATE   LLM at configurable temperature, grounded strictly in context
         ─▶ 6. FALLBACK   LLM emits INSUFFICIENT_INFORMATION → escalate to human
```

**Fallback reason codes:** `LOW_CLASSIFICATION_CONFIDENCE`, `NO_RELEVANT_KNOWLEDGE`, `LOW_RETRIEVAL_CONFIDENCE`, `LLM_INSUFFICIENT_INFORMATION`

### 4.2 LLM Providers (Environment Default Path)

| Provider | Model | Variable |
|----------|-------|----------|
| OpenAI | `gpt-4o-mini` | `LLM_API_KEY` |
| Gemini | `gemini-2.0-flash` | `GEMINI_API_KEY` |
| Grok (xAI) | `grok-3-mini` | `GROK_API_KEY` |

### 4.3 Provider Layer (Model Catalog Path) — 5 Adapters

| Slug | Adapter | SDK | Credential |
|------|---------|-----|------------|
| `openrouter` | `OpenRouterProvider` | `langchain-openai` | `OPENROUTER_API_KEY` |
| `openai` | `OpenAIProvider` | `langchain-openai` | `OPENAI_API_KEY` |
| `groq` | `GroqProvider` | `langchain-groq` | `GROQ_API_KEY` |
| `gemini` | `GeminiProvider` | `langchain-google-genai` | `GEMINI_API_KEY` |
| `openai_compatible` | `OpenAICompatibleProvider` | `langchain-openai` | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` |

**Architecture:**
- All adapters implement the `LLMProvider` Protocol (`slug`, `is_configured`, `generate`)
- Four OpenAI-wire adapters share `openai_wire.py` for error classification and failure policy
- Gemini has its own client but shares the envelope
- Registry enforces unique slugs; duplicate raises on registration
- Adapters load lazily on first lookup

### 4.4 Provider Error Handling

| Kind | Raised When | Node Mapping |
|------|-------------|-------------|
| `NOT_CONFIGURED` | No credential present | `MODEL_UNAVAILABLE` |
| `AUTH` | Provider rejected credential (401/402/403) | `MODEL_UNAVAILABLE` |
| `RATE_LIMIT` | Throttled | `MODEL_RATE_LIMITED` |
| `UPSTREAM` | Provider 5xx | `MODEL_ERROR` |
| `TIMEOUT` | Request timeout exceeded | `MODEL_ERROR` |
| `BAD_REQUEST` | Provider rejected request (400) | `MODEL_UNAVAILABLE` |
| `UNKNOWN_PROVIDER` | No adapter for slug | `MODEL_UNAVAILABLE` |
| `UNKNOWN` | Anything else | `MODEL_ERROR` |

### 4.5 Embedding Providers

| Provider | Model | Dimensions | Mode |
|----------|-------|-----------|------|
| OpenAI | `text-embedding-3-small` | 1536 | API |
| HuggingFace | `all-MiniLM` | 384 | Local (free) |

### 4.6 ML Components

- **Intent classifier:** TF-IDF + LogisticRegression, trained from `training_data.csv` (~473KB of training data)
- **Escalation model:** Separate ML component for escalation decisions
- **Training:** `python -m app.ml.training.train` (required before first start)
- **Evaluation:** `GET /api/v1/ml/evaluate` returns F1, Precision, Recall scores

### 4.7 RAG Pipeline Components

| Component | Files |
|-----------|-------|
| **Ingestion** | `app/rag/ingestion/` — document loading, chunking |
| **Retrieval** | `app/rag/retrieval/` — pgvector semantic search |
| **Generation** | `app/rag/generation/` — LLM response generation |
| **Chunking** | `services/chunking_service.py` — text splitting |
| **Document loading** | `services/document_service.py` — PDF/DOCX extraction |

### 4.8 Services Layer

14 service files:

| Service | Purpose |
|---------|---------|
| `chat_service.py` | Full chat pipeline orchestration (40KB — the core) |
| `knowledge_service.py` | Knowledge ingestion + management |
| `vector_store_service.py` | pgvector operations |
| `embedding_service.py` | Embedding generation (OpenAI/HuggingFace) |
| `retrieval_service.py` | Semantic search |
| `llm_service.py` | LLM generation |
| `classifier_service.py` | Intent classification |
| `escalation_service.py` | Escalation logic |
| `fallback_service.py` | Fallback handling |
| `chunking_service.py` | Text chunking |
| `document_service.py` | Document extraction |
| `ml_service.py` | ML model management |
| `rag_service.py` | RAG pipeline coordination |

### 4.9 API Routes

| Route File | Endpoints |
|------------|-----------|
| `chat.py` | `POST /api/v1/chat` |
| `knowledge.py` | `POST /api/v1/knowledge/ingest`, `POST /api/v1/knowledge/ingest-document`, `DELETE /api/v1/knowledge/{bot_id}`, chunk management |
| `classifier.py` | `POST /api/v1/ml/classify`, `GET /api/v1/ml/evaluate` |
| `ai.py` | `GET /api/v1/ai/status` |
| `testing.py` | `GET /api/v1/testing/status`, `POST /api/v1/testing/chat-pipeline`, vector store stats |
| `rag.py` | RAG-specific endpoints |
| `health.py` | `GET /health` |

### 4.10 Prompt System

- Dedicated `app/prompts/` directory for prompt templates
- System prompts incorporate bot personality, tone, custom instructions
- Prompt hierarchy: Core rules > personality > custom instructions
- INSUFFICIENT_INFORMATION sentinel for fallback detection

### 4.11 LangGraph Agent (Experimental)

- `app/agents/` contains a LangGraph-based pipeline (`graph.py`, `nodes.py`, `state.py`)
- Experimental — not the primary production path

### 4.12 Security & Multi-Tenancy

- `X-API-Key` authentication on all protected endpoints
- No disabled mode — missing key → 503 on all protected routes
- Every vector search scoped by `bot_id`
- Credential redaction in logs via `app.core.redaction.redact()`
- Provider credentials never stored in DB, never sent to browser
- Structured logging with JSON option (`LOG_FORMAT=json`)

---

## 5. Client (Next.js Frontend) — Implemented Features

### 5.1 App Router Pages

| Route | Page | Status |
|-------|------|--------|
| `/` | Landing/redirect | ✅ |
| `/login` | Login form | ✅ |
| `/register` | Registration form | ✅ |
| `/dashboard` | Workspace selector | ✅ |
| `/dashboard/workspaces` | Workspace list | ✅ |
| `/dashboard/workspaces/[workspaceId]` | Workspace detail with bots | ✅ |
| `/dashboard/bots/[botId]` | Bot detail with config tabs | ✅ |
| `/dashboard/bots/[botId]/knowledge` | Knowledge management (FAQ + Sources + Chunks) | ✅ |
| `/dashboard/bots/[botId]/knowledge/sources/[sourceId]` | Source detail / chunk viewer | ✅ |
| `/dashboard/bots/[botId]/conversations` | Conversation list + chat interface | ✅ |
| `/platform` | Platform admin dashboard | ✅ |
| `/platform/models` | Model catalog management | ✅ |
| `/platform/ai-lab` | AI service operations console | ✅ |
| `/platform/settings` | Platform settings (upload limits) | ✅ |
| `/platform/users` | User management | ✅ |
| `/platform/system` | System overview | ✅ |
| `/platform/workspaces` | All workspaces (platform view) | ✅ |

### 5.2 Bot Configuration UI — 19 Component Files

The bot detail page includes a comprehensive tabbed configuration interface:

| Component | Purpose |
|-----------|---------|
| `bot-config-tabs.tsx` | Main tab container |
| `general-tab.tsx` | Name, description, active toggle |
| `appearance-tab.tsx` | Display name customization |
| `avatar-uploader.tsx` | Avatar image upload |
| `bot-avatar.tsx` | Avatar display component |
| `personality-tab.tsx` | Personality preset + custom personality |
| `ai-model-tab.tsx` | Primary + fallback model selection |
| `conversation-tab.tsx` | Welcome message, starters, suggested questions |
| `knowledge-tab.tsx` | Knowledge strictness, sources toggle, retrieval params |
| `human-support-tab.tsx` | Fallback behavior, handoff message |
| `business-hours-editor.tsx` | Business hours windows per day |
| `contact-fields-editor.tsx` | Contact collection configuration |
| `suggested-questions-editor.tsx` | Suggested question chips editor |
| `thinking-messages-editor.tsx` | Thinking animation messages |
| `preview-panel.tsx` | Live chat preview panel |
| `chat-message.tsx` | Chat message rendering |
| `unsaved-changes-bar.tsx` | Dirty state indicator |
| `config-options.ts` | Shared option definitions |
| `tab-props.ts` | Shared tab prop types |

### 5.3 Knowledge Management UI — 8 Component Files

| Component | Purpose |
|-----------|---------|
| `faq-tab.tsx` | FAQ entry CRUD |
| `sources-tab.tsx` | Document source list |
| `chunks-tab.tsx` | Chunk browser with search/filter |
| `retrieval-tab.tsx` | Retrieval testing interface |
| `upload-dialog.tsx` | Multi-file upload dialog |
| `chunk-editor-dialog.tsx` | Inline chunk content editing |
| `stats-cards.tsx` | Knowledge statistics |
| `status-badge.tsx` | Source processing status badges |

### 5.4 Shared UI Components — 20 Components

| Component | Type |
|-----------|------|
| `button.tsx` | Interactive |
| `input.tsx` | Form |
| `textarea.tsx` | Form |
| `select.tsx` | Form |
| `checkbox.tsx` | Form |
| `radio-group.tsx` | Form |
| `slider.tsx` | Form |
| `switch.tsx` | Form |
| `field.tsx` | Form layout |
| `file-input.tsx` | File upload |
| `search-input.tsx` | Search with debounce |
| `card.tsx` | Layout |
| `badge.tsx` | Display |
| `tabs.tsx` | Navigation |
| `dialog.tsx` | Modal |
| `confirm-dialog.tsx` | Confirmation modal |
| `toast.tsx` | Notifications |
| `spinner.tsx` | Loading |
| `empty-state.tsx` | Empty content |
| `pagination.tsx` | Pagination controls |

### 5.5 Infrastructure

| File | Purpose |
|------|---------|
| `lib/api-client.ts` | HTTP client with JWT injection + error handling |
| `lib/auth-context.tsx` | React context for auth state |
| `lib/permissions.ts` | Client-side permission checks (mirrors server matrix) |
| `lib/format.ts` | Formatting utilities |
| `lib/api/*.ts` | 11 domain-specific API modules |
| `components/auth-guard.tsx` | Route protection |
| `components/platform-guard.tsx` | Platform owner route protection |
| `components/sidebar.tsx` | Navigation sidebar |
| `components/app-shell.tsx` | Layout wrapper |
| `components/api-error-bridge.tsx` | API error display |

### 5.6 API Client Modules (11 files)

| Module | Coverage |
|--------|----------|
| `auth.ts` | Login, register |
| `workspaces.ts` | Workspace CRUD |
| `bots.ts` | Bot CRUD |
| `botConfig.ts` | Config get/update/reset/preview + avatar |
| `knowledge.ts` | FAQ CRUD |
| `knowledgeSources.ts` | Source upload/list/delete |
| `knowledgeChunks.ts` | Chunk list/edit/toggle |
| `conversations.ts` | Conversation + message operations |
| `models.ts` | Model catalog queries |
| `ai.ts` | AI service status/debug |
| `platform.ts` | Platform admin operations |

---

## 6. Testing — Current Coverage

### 6.1 Server Tests (29 test files)

| Test File | What It Covers |
|-----------|---------------|
| `auth.test.ts` | Register, duplicate email, invalid input, login, protected routes |
| `workspace.test.ts` | Create, cross-tenant read → 404 |
| `bot.test.ts` | Create, workspace ownership, cross-tenant → 404 |
| `bot-model.test.ts` | Model assignment: unknown/disabled/provider-disabled → 400 |
| `bot-model-resolution.test.ts` | Primary/fallback model resolution logic |
| `botModelFallback.test.ts` | Failover: primary → fallback → default |
| `botConfig.test.ts` | Config CRUD, defaults merging, optimistic concurrency |
| `botConfigIntegration.test.ts` | Config + chat pipeline integration |
| `botConfigPreview.test.ts` | System prompt preview generation |
| `botAvatar.test.ts` | Avatar upload/serve/delete with ETag |
| `botDeleteCascade.test.ts` | Cascading deletes |
| `businessHours.test.ts` | Business hours evaluation |
| `conversation.test.ts` | Create, sendMessage, cross-tenant → 404 |
| `conversationEscalation.test.ts` | Escalation behavior + reason codes |
| `conversationFeedback.test.ts` | Feedback submit/update/delete |
| `conversationContact.test.ts` | Contact details CRUD |
| `knowledgeSources.test.ts` | Source upload lifecycle |
| `knowledgeChunks.test.ts` | Chunk management + re-embedding |
| `knowledgeDeleteAll.test.ts` | Bulk knowledge deletion |
| `ai-catalog.test.ts` | Full catalog lifecycle, credential scanning |
| `aiServiceClient.test.ts` | AI service client boundary |
| `authorization.test.ts` | Permission checks |
| `rbac-matrix.test.ts` | Every role × every route (64KB — comprehensive) |
| `rbac-compat.test.ts` | Service-layer scope predicates |
| `rbac-routes.test.ts` | Route-level RBAC |
| `model-concurrency.test.ts` | Concurrent model operations |
| `model-disable-lifecycle.test.ts` | Model enable/disable lifecycle |
| `platformSettings.test.ts` | Platform settings CRUD |

**Testing approach:** Vitest + Supertest with Prisma & AI service mocked — no DB, no Python needed.

### 6.2 AI Service Tests (22 test files)

| Test File | What It Covers |
|-----------|---------------|
| `test_health.py` | Health endpoint |
| `test_auth.py` | API key authentication |
| `test_ai.py` | AI status/provider reporting |
| `test_chat_backward_compat.py` | Pre-catalog chat behavior preserved |
| `test_chat_model_routing.py` | Catalog model routing |
| `test_chat_config_defaults.py` | Bot config defaults in chat |
| `test_generation_params.py` | Temperature, topP, etc. |
| `test_knowledge_ingestion.py` | FAQ ingestion |
| `test_knowledge_management.py` | Knowledge CRUD lifecycle |
| `test_knowledge_strictness.py` | Strictness levels in retrieval |
| `test_providers.py` | Provider adapter tests |
| `test_openrouter.py` | OpenRouter-specific behavior |
| `test_catalog_providers.py` | Catalog provider integration |
| `test_model_failover.py` | Primary → fallback failover |
| `test_provider_error_logging.py` | Error logging with redaction |
| `test_prompt_hierarchy.py` | Prompt priority/hierarchy |
| `test_human_request.py` | Human handoff detection |
| `test_retrieval_integration.py` | End-to-end retrieval |
| `test_sources.py` | Source tracking |
| `test_upload_errors.py` | Upload validation errors |

**Testing approach:** pytest + FastAPI TestClient.

---

## 7. What Is Working End-to-End

These features are fully implemented across all three services (Client → Server → AI):

1. ✅ **User authentication** — Register, login, JWT-protected routes
2. ✅ **Multi-tenancy** — Strict workspace isolation at every layer
3. ✅ **Workspace management** — Create, list, view workspaces
4. ✅ **Member management** — Add/remove/update workspace members with roles
5. ✅ **Bot CRUD** — Full lifecycle with cascading deletes
6. ✅ **Bot configuration** — Personality, tone, instructions, welcome message, suggested questions, response length/language, thinking messages, feedback settings, knowledge strictness, generation params, human support settings, business hours, contact collection, avatar upload
7. ✅ **FAQ knowledge management** — Create, edit, delete entries → synced to vector store
8. ✅ **Document knowledge ingestion** — Multi-file PDF/DOCX upload → text extraction → chunking → embedding → pgvector
9. ✅ **Knowledge chunk management** — List, edit content, enable/disable, re-embed
10. ✅ **Chat with AI** — Deterministic RAG pipeline with intent classification, retrieval, grounded generation, and human escalation
11. ✅ **Conversation management** — Create, list, view, resolve/reopen conversations
12. ✅ **Human escalation** — Fallback detection with reason codes, status flip to WAITING_FOR_HUMAN, business hours awareness
13. ✅ **Message feedback** — Thumbs up/down with reason codes on assistant messages
14. ✅ **Conversation contacts** — Customer contact details per conversation
15. ✅ **Model catalog** — Platform-owner curated, multi-provider model selection per bot
16. ✅ **Model failover** — Primary → fallback → environment default
17. ✅ **RBAC** — Platform roles + workspace roles with full permission matrix
18. ✅ **AI Lab** — Operations console for ML evaluation, vector stats, pipeline debugging
19. ✅ **Platform admin** — Provider management, model catalog, system settings, user management, workspace overview
20. ✅ **Platform settings** — Configurable upload limits and chunk limits
21. ✅ **Bot avatar** — Upload, serve with ETag caching, delete
22. ✅ **Structured logging** — Credential redaction across both services

---

## 8. What Is Explicitly Not Implemented (Deferred)

| Feature | Current State | Notes |
|---------|--------------|-------|
| **Human handoff routing** | Status is set to `WAITING_FOR_HUMAN`, but no agent routing/queue exists | Infrastructure is in place (assignedAgentId field exists) |
| **Streaming responses** | Chat responses are blocking round-trips; no SSE/WebSocket | Architecture supports adding it |
| **Conversation memory** | Only the current message is sent to the AI; prior turns not included | Pipeline takes single message |
| **Server-side logout** | No token blacklist; logout is client-side only | JWT is stateless |
| **Pagination on list endpoints** | Not implemented on server list endpoints | Client has `pagination.tsx` component ready |
| **Real-time updates** | No WebSocket/SSE for live updates | Would need socket layer |
| **Audit trail** | Catalog changes logged but no audit table or endpoint | Log records are the only trail |
| **Live provider reachability** | Readiness checks are credential-present, not live-connection | Deliberate scope decision |
| **Conversation assignment flow** | `assignedAgentId` field exists but no assignment UI/logic | Schema ready |
| **Token refresh/rotation** | Single long-lived JWT, no refresh tokens | Auth flow is stateless |

---

## 9. Project File Counts

| Area | Files | Notes |
|------|-------|-------|
| **Server source** (`src/`) | ~60+ TypeScript files | 13 controllers, 22 services, 13 route files, 11 schemas, 6 middleware |
| **Server tests** | 29 test files | ~400KB+ of test code |
| **AI source** (`app/`) | ~40+ Python files | 14 services, 8 route files, 9 provider files, ML + RAG modules |
| **AI tests** | 22 test files | ~300KB+ of test code |
| **Client source** | ~50+ TSX/TS files | 20+ pages, 19 bot config components, 8 knowledge components, 20 UI components, 11 API modules |
| **Prisma schema** | 1 file, 556 lines | 16 models, 10 enums |
| **Migrations** | 5 migrations | Progressive, additive, non-destructive |

---

## 10. Environment & Infrastructure

### 10.1 Docker Compose Files

- `app/server/docker-compose.yml` — PostgreSQL 16 on port **5432** (relational data)
- `app/Ai/docker-compose.yml` — pgvector (PostgreSQL 16 + vector extension) on port **5433** (vector store)

### 10.2 Configuration Files

| File | Purpose |
|------|---------|
| `app/server/.env.example` | Server environment template |
| `app/Ai/.env.example` | AI service environment template |
| `app/Client/.env.local` | Client API URL |
| `app/server/vitest.config.ts` | Server test configuration |
| `app/Client/vitest.config.ts` | Client test configuration |

### 10.3 Seed & Verification Scripts

| Command | Purpose |
|---------|---------|
| `npm run db:seed` | Seeds RBAC data + promotes `PLATFORM_OWNER_EMAIL` |
| `npm run verify:rbac` | Verifies every workspace has an OWNER membership |

---

## 11. License

ISC
