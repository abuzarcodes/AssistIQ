# AssistIQ — Current State of the Project

> **Generated:** 2026-10-26
> **Supersedes:** the 2026-10-11 snapshot
> **Basis:** direct inspection of the repository, the live database, a full test run, production builds, and end-to-end ingestion/chat verification on 2026-10-26.

This document describes what is actually in the tree and running today, not the original plan. Where the old snapshot and the code disagreed, the code won.

---

## 0. Read This First

**AssistIQ is working end to end.** The three services build, the automated suites pass, document ingestion succeeds for valid PDF/DOCX files, retrieval works, and a public visitor can hold a grounded conversation with a bot and escalate to a human.

The most important corrections to the previous snapshot:

- There are **6 migrations**, **16 Prisma models**, and **13 enums** — not 5 migrations / 16 models / 10 enums.
- Human handoff is no longer deferred. There is a **workspace support queue, inbox, claim/assign/unassign/resolve/reopen lifecycle, durable conversation events, and Socket.IO realtime delivery**.
- There is a **public visitor surface**: visitor tokens, session refresh, a hosted customer widget at `/widget/[botId]`, and public conversation/message/contact endpoints.
- The primary UI is now the **`/w/[workspaceId]/*` route namespace**. The old `/dashboard/*` URLs still exist, but they redirect or bridge to the new routes.
- The server has **800 passing tests in 34 suites**, the AI service has **644 passing tests**, and the client has **59 passing tests in 15 files**.
- The previous ingestion failures were caused by the Node-to-AI timeout being shorter than a cold HuggingFace embedding load. `AI_SERVICE_TIMEOUT` is now **120000 ms** locally.
- Four sources uploaded on **2026-10-21** are still stored as `FAILED` with the old generic AI-unavailable message. They need to be re-uploaded; the fix does not retroactively reprocess them.

Current database counts:

| Entity | Count |
|---|---:|
| Users | 8 |
| Workspaces | 9 |
| Bots | 7 |
| Knowledge sources | 26 (22 `PROCESSED`, 4 `FAILED`) |
| Knowledge chunks | 123 |
| Conversations | 32 |
| Messages | 175 |
| Conversation events | 45 |

---

## 1. Project Overview

AssistIQ is a multi-tenant, AI-powered customer-support SaaS. A business creates a **Workspace**, builds **Bots**, fills them with **Knowledge** (FAQ entries and uploaded documents), and lets customers chat with those bots through the dashboard, a hosted widget, or an agent inbox.

The monorepo has three independently runnable services:

| Service | Stack | Port | Role |
|---|---|---|---|
| **Client** | Next.js 16.3.2, React 19.2.8, Tailwind v4 | `3000` | Dashboard, support inbox, bot configuration, public widget |
| **Server** | Node 22.19, Express 4.21, Prisma 6.4, TypeScript | `5000` | API, auth, RBAC, tenant isolation, conversation lifecycle, realtime |
| **AI** | Python 3.14.7, FastAPI, LangChain, pgvector, scikit-learn | `8000` | RAG pipeline, intent classification, LLM generation |

Communication flow:

```
Browser / public visitor
        │
        │ HTTPS + JWT (member) or visitor token (customer)
        ▼
   Next.js client :3000
        │  REST /api/v1/*  +  Socket.IO
        ▼
   Express server :5000
        │  /api/v1/chat, ingestion, retrieval
        │  X-API-Key
        ▼
   FastAPI AI service :8000
        │
        ├── PostgreSQL 18.6 :5432  (Prisma relational data)
        └── PostgreSQL + pgvector :5433  (embeddings)
```

The browser never talks to the AI service directly. The AI service is a private backend-for-backend.

---

## 2. Runtime State and Environment (2026-10-26)

### 2.1 Services Running

| Component | State | Notes |
|---|---|---|
| Native PostgreSQL | Running on `5432` | `assistiq_db`, user `postgres`, PostgreSQL 18.6. This is the database Prisma actually uses. |
| `assistiq-pgvector` Docker container | Running on `5433` | Vector store database `assistiq`, table `knowledge_chunks`, 384-dimensional vectors. |
| AI service | Running on `:8000` | Started under global Python 3.14.7. `/health` returns `{"status":"ok","service":"assistiq-ai"}`. |
| Server | Running on `:5000` | `/health` returns `{"success":true,"status":"healthy","service":"assistiq-backend"}`. |
| Client | Not running at snapshot time | Production build succeeded; start with `npm run dev`. |

A Docker container named `assistiq-postgres` was created during testing and then removed because it conflicts with the native PostgreSQL already bound to `5432`. Do not start `app/server/docker-compose.yml` while the native service is running.

`reconcileos-redis` is also present on the machine and is unrelated to AssistIQ. Redis is configured in `app/Ai/.env` but is not on the current RAG path.

### 2.2 Local Configuration Caveats

| Item | Actual state | Impact |
|---|---|---|
| `app/server/.env` `AI_SERVICE_TIMEOUT` | Changed from `30000` to `120000` on 2026-10-26 | Required for cold HuggingFace embedding loads and slow Gemini calls. The file is gitignored, so this is a local-only change. |
| `app/server/.env` `AI_SERVICE_MODE` | Set to `"mock"` but **no code reads it** | Dead configuration. AI vs mock behavior is controlled by `AI_SERVICE_URL` and whether the AI service is reachable. |
| `app/Ai/.venv` | Exists but is a stub: `Lib/site-packages` contains only `pip` | The AI service runs under the global Python 3.14.7 install, not this venv. The README still says Python 3.12. |
| Gemini model | `GEMINI_MODEL="gemini-3.6-flash"` | Correct but slow: 31-68 s for a full grounded RAG turn. This is why the server timeout was raised. |
| Embedding model | `EMBEDDING_PROVIDER=huggingface`, dimension `384` | The HF path uses `all-MiniLM-L6-v2`; `EMBEDDING_MODEL="text-embedding-3-small"` is an OpenAI default that the HF branch does not use. First load is cold-start expensive (34.7 s measured). |
| CORS | `CORS_ORIGIN="*"` | Fine for local development, not for production. |
| Client env | `NEXT_PUBLIC_API_URL` defaults to `http://localhost:5000/api/v1` | Socket URL is derived from it unless `NEXT_PUBLIC_SOCKET_URL` is set. |

### 2.3 Stale Data That Needs Action

Four sources from 2026-10-21 remain `FAILED` on bot `39363ce6-3ce7-4771-adb7-734d4ad4766d`:

- `Community_Connect_Report_template.docx`
- `Community_Connect_Report_Final - w.e(o).docx` (uploaded twice)
- `TOC Assignment — PDA, CFL Properties & Parsing.pdf`

All four store:

> `The AI service is currently unavailable. Please try again later.`

That message is produced only when the Node server cannot reach the AI service or the request times out. The embedding cold-start measurement (34.7 s) combined with the old 30 s server timeout explains the failures. Valid uploads now succeed with the higher timeout. The four rows should be deleted or re-uploaded; they will not self-heal.

---

## 3. Database and Data Model

### 3.1 Relational Database

Prisma connects to the native PostgreSQL instance:

```
postgresql://postgres:<password>@localhost:5432/assistiq_db?schema=public
```

The schema is `app/server/prisma/schema.prisma` (656 lines, 16 models, 13 enums).

### 3.2 Migrations

| Migration | What it does |
|---|---|
| `0_init` | Base users, workspaces, bots, knowledge entries, conversations, messages |
| `20261002141705_init_rbac` | Platform/workspace roles and `workspace_members` |
| `20261002181628_add_ai_model_catalog` | `ai_providers`, `ai_models`, bot model references |
| `20261003170937_add_knowledge_management` | Sources, chunks, platform settings |
| `20261004170014_add_bot_configuration` | Bot configuration, feedback, contacts |
| `20261011190000_add_human_escalation` | `HUMAN_ACTIVE` status, `AGENT` message role, conversation `workspaceId` backfill, assignment/escalation fields, `version`, visitor session hash, `conversation_events` |

The human-escalation migration is hand-edited only around the `workspaceId` backfill: it adds the column nullable, copies it from `bots.workspaceId`, verifies no nulls remain, then sets `NOT NULL` and adds the queue indexes.

### 3.3 Entity Hierarchy

```
User ──owns──▶ Workspace ──has──▶ Bot ──has──▶ KnowledgeEntry (FAQ)
                    │                  ├─has──▶ KnowledgeSource ──has──▶ KnowledgeChunk
                    │                  ├─has──▶ Conversation ──has──▶ Message
                    │                  │            ├─has──▶ ConversationContact
                    │                  │            ├─has──▶ MessageFeedback
                    │                  │            └─has──▶ ConversationEvent (audit)
                    │                  ├─refs──▶ AIModel (primary)
                    │                  ├─refs──▶ AIModel (fallback)
                    │                  └─has──▶ BotConfiguration (1:1)
                    └──has──▶ WorkspaceMember (RBAC)

AIProvider ──has──▶ AIModel (platform catalog)
PlatformSetting (singleton row)
Conversation ──assignedAgent──▶ User
Message ──sender──▶ User (AGENT messages only)
```

### 3.4 Models and Enums

Models (16): `User`, `WorkspaceMember`, `Workspace`, `Bot`, `KnowledgeEntry`, `Conversation`, `Message`, `ConversationEvent`, `AIProvider`, `AIModel`, `KnowledgeSource`, `KnowledgeChunk`, `PlatformSetting`, `BotConfiguration`, `MessageFeedback`, `ConversationContact`.

Enums (13): `MessageRole`, `PlatformRole`, `WorkspaceRole`, `ConversationStatus`, `ConversationEventType`, `KnowledgeSourceStatus`, `BotPersonality`, `BotTone`, `ResponseLength`, `KnowledgeStrictness`, `HumanRequestBehavior`, `AfterHoursBehavior`, `FeedbackRating`.

Important enum values:

- `MessageRole`: `USER`, `ASSISTANT`, `SYSTEM`, `AGENT`
- `ConversationStatus`: `ACTIVE`, `WAITING_FOR_HUMAN`, `HUMAN_ACTIVE`, `RESOLVED`
- `ConversationEventType`: `ESCALATED`, `CLAIMED`, `ASSIGNED`, `REASSIGNED`, `UNASSIGNED`, `AGENT_REPLIED`, `RESOLVED`, `REOPENED`
- `KnowledgeSourceStatus`: `PENDING`, `PROCESSING`, `PROCESSED`, `FAILED`
- `WorkspaceRole`: `OWNER`, `ADMIN`, `AGENT`
- `PlatformRole`: `USER`, `PLATFORM_OWNER`

### 3.5 Conversation and Message Fields That Matter

`Conversation` now carries:

- `workspaceId` — denormalised from the bot for queue and tenant queries.
- `status` — the four-state lifecycle.
- `assignedAgentId` — non-null exactly when a human owns the conversation.
- `escalatedAt`, `escalationReason`, `escalatedOffHours`.
- `resolvedAt`.
- `version` — optimistic concurrency token; protects an in-flight AI turn from writing a stale answer after a human takes over.
- `visitorSessionHash` — SHA-256 of the visitor refresh secret; null for dashboard-created conversations.

`Message` now carries:

- `role` including `AGENT`.
- `senderId` for human agents.
- `clientMessageId` for widget idempotency/reconciliation.
- `sources` JSON for citations when `showSources` is enabled.

`ConversationEvent` is the durable audit trail for lifecycle transitions. Every transition writes an event in the same transaction as the state change.

### 3.6 Vector Database

Separate PostgreSQL instance with the `vector` extension on port `5433`:

```
postgresql://postgres:<password>@localhost:5433/assistiq
```

The AI service owns a `knowledge_chunks` table with 384-dimensional embeddings. Row IDs are shared with Prisma `KnowledgeChunk` rows; the relational row holds display/metadata state, the vector row holds the embedding. Every retrieval query is scoped by `bot_id`.

---

## 4. Server (Express + Prisma)

### 4.1 Authentication

- `POST /api/v1/auth/register` — name, email, password (>= 8 chars), returns JWT and safe user.
- `POST /api/v1/auth/login` — generic invalid-credentials message for both unknown email and wrong password.
- `POST /api/v1/auth/logout` — client-side only; JWT is stateless.
- JWT middleware on every protected namespace.
- bcryptjs with 12 salt rounds.
- Auth rate limit: 20 requests per 15 minutes per IP on register/login.
- JWT lifetime: `JWT_EXPIRES_IN`, currently `7d`.

### 4.2 Authorization (RBAC)

Two independent authorization domains:

| Domain | Roles | Scope |
|---|---|---|
| Platform | `USER`, `PLATFORM_OWNER` | AI Lab, model catalog, platform administration |
| Workspace | `OWNER`, `ADMIN`, `AGENT` | Bots, knowledge, conversations, members |

Current workspace permission behavior:

| Capability | OWNER | ADMIN | AGENT |
|---|---|---|---|
| View workspace | Yes | Yes | Yes |
| Update/delete workspace | Permission defined, no route yet | No | No |
| View members | Yes | Yes | No |
| Manage members | Yes | No | No |
| View bots | Yes | Yes | No |
| Manage bots/config | Yes | Yes | No |
| View knowledge/documents | Yes | Yes | Yes |
| Manage knowledge/documents | Yes | Yes | No |
| View conversations | Yes | Yes | Yes |
| Reply to conversations | Yes | Yes | Yes |
| Claim/unclaim own work | Yes | Yes | Yes |
| Assign to another agent | Yes | Yes | No |
| Resolve/reopen | Yes | Yes | Yes |
| Manage conversations | Yes | Yes | No |
| Billing | Yes | No | No |

Denial semantics are unchanged:

- No membership → `404` (never leaks existence).
- Member without permission → `403`.
- Not authenticated → `401`.

Implementation:

- `requireWorkspacePermission(permission, scope)` resolves the workspace from `workspace`, `bot`, `knowledge`, `knowledgeSource`, `knowledgeChunk`, or `conversation`.
- `requirePlatformOwner()` guards platform/admin namespaces.
- Platform role is re-read from the database, not trusted from the JWT.

### 4.3 Multi-Tenancy

- Ownership is enforced in the service layer through Prisma queries whose `WHERE` includes the ownership chain.
- Cross-tenant IDs resolve to `null` → `404`.
- Child resource creation first asserts ownership of the parent.
- Owner/agent identity always comes from the verified token, never request bodies.
- Cascading deletes are declared in Prisma.

### 4.4 Workspaces and Members

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/workspaces` | Creates workspace; caller becomes OWNER |
| GET | `/api/v1/workspaces` | Lists caller's memberships |
| GET | `/api/v1/workspaces/:workspaceId` | Requires `workspace:view` |
| GET | `/api/v1/workspaces/:workspaceId/members` | `members:view` |
| POST | `/api/v1/workspaces/:workspaceId/members` | `members:manage` (OWNER) |
| PATCH | `/api/v1/workspaces/:workspaceId/members/:memberId` | `members:manage` |
| DELETE | `/api/v1/workspaces/:workspaceId/members/:memberId` | `members:manage`; also evicts revoked sockets |

There are still no workspace update/delete endpoints even though the permission strings exist.

### 4.5 Bots and Configuration

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/workspaces/:workspaceId/bots` | `bots:manage` |
| GET | `/api/v1/workspaces/:workspaceId/bots` | `bots:view` |
| GET | `/api/v1/bots/:botId` | `bots:view` |
| PATCH | `/api/v1/bots/:botId` | `bots:manage` |
| DELETE | `/api/v1/bots/:botId` | `bots:manage`, cascades |
| PATCH | `/api/v1/bots/:botId/model` | Assign/clear primary model |
| GET | `/api/v1/bots/:botId/config` | Resolved config with defaults |
| PATCH | `/api/v1/bots/:botId/config` | Partial update, optimistic concurrency |
| POST | `/api/v1/bots/:botId/config/reset` | Reset to defaults |
| POST | `/api/v1/bots/:botId/config/preview` | Real provider preview call; `bots:manage` |
| POST | `/api/v1/bots/:botId/avatar` | Upload, guarded before multer |
| GET | `/api/v1/bots/:botId/avatar` | Serve with ETag |
| DELETE | `/api/v1/bots/:botId/avatar` | Remove |

Bot configuration covers personality, tone, custom personality/instructions, response language/length, welcome message, conversation starter, suggested questions, input placeholder, thinking messages, feedback settings, knowledge enablement/strictness/sources/top-K, generation parameters, human-support behavior, handoff message, business hours, contact collection, and avatar.

### 4.6 Knowledge: FAQ, Sources, Chunks

FAQ:

| Method | Path |
|---|---|
| POST | `/api/v1/bots/:botId/knowledge` |
| GET | `/api/v1/bots/:botId/knowledge` |
| DELETE | `/api/v1/bots/:botId/knowledge` (delete all knowledge) |
| POST | `/api/v1/bots/:botId/knowledge/upload-document` (legacy single-file path) |
| PATCH | `/api/v1/knowledge/:knowledgeId` |
| DELETE | `/api/v1/knowledge/:knowledgeId` |

Document sources:

| Method | Path |
|---|---|
| POST | `/api/v1/bots/:botId/knowledge-sources/upload` |
| GET | `/api/v1/bots/:botId/knowledge-sources` |
| GET | `/api/v1/bots/:botId/knowledge-sources/upload-limits` |
| GET | `/api/v1/knowledge-sources/:sourceId` |
| DELETE | `/api/v1/knowledge-sources/:sourceId` |

Chunks and retrieval testing:

| Method | Path |
|---|---|
| GET | `/api/v1/bots/:botId/knowledge-chunks` |
| GET | `/api/v1/bots/:botId/knowledge-chunks/stats` |
| POST | `/api/v1/bots/:botId/knowledge-chunks/bulk` |
| POST | `/api/v1/bots/:botId/knowledge-test` |
| GET | `/api/v1/knowledge-chunks/:chunkId` |
| PATCH | `/api/v1/knowledge-chunks/:chunkId` (content edit triggers re-embed) |
| DELETE | `/api/v1/knowledge-chunks/:chunkId` |

Upload behavior:

- Accepts PDF and DOCX only.
- Multi-file batch upload; per-file lifecycle `PENDING → PROCESSING → PROCESSED | FAILED`.
- Limits come from `PlatformSetting`: 10 MB per file, 10 files per request, 50 MB total, 5,000 chunks per source, optional per-bot chunk cap, 100 MB absolute AI ceiling.
- Permission guard runs **before** multer, so unauthorized callers never cause body buffering.
- A bad file fails alone; siblings still succeed and the batch returns 201.

### 4.7 Conversations, Queue, and Inbox

Member-facing endpoints:

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/bots/:botId/conversations` | Create conversation |
| GET | `/api/v1/bots/:botId/conversations` | List bot conversations (unpaginated) |
| GET | `/api/v1/workspaces/:workspaceId/conversations/queue` | Cross-bot support queue |
| GET | `/api/v1/conversations/:conversationId` | Conversation plus messages/contact |
| POST | `/api/v1/conversations/:conversationId/messages` | Human prompts the AI |
| POST | `/api/v1/conversations/:conversationId/reply` | Human replies as AGENT |
| POST | `/api/v1/conversations/:conversationId/messages/:messageId/feedback` | Upsert feedback |
| DELETE | `/api/v1/conversations/:conversationId/messages/:messageId/feedback` | Remove feedback |
| POST | `/api/v1/conversations/:conversationId/contact` | Upsert contact |
| POST | `/api/v1/conversations/:conversationId/claim` | Take unassigned ticket |
| POST | `/api/v1/conversations/:conversationId/assign` | Assign to another agent |
| POST | `/api/v1/conversations/:conversationId/unassign` | Return to queue |
| POST | `/api/v1/conversations/:conversationId/resolve` | Close ticket |
| POST | `/api/v1/conversations/:conversationId/reopen` | Reopen, assigned to actor |
| GET | `/api/v1/conversations/:conversationId/events` | Durable audit trail |
| GET | `/api/v1/conversations/:conversationId/messages` | Cursor transcript recovery |

Queue views: `unassigned` (default), `assigned`, `all_active`, `resolved`. Limit max 100. Unassigned and all-active are ordered by escalation time, then creation time. Resolved is ordered by resolution time descending.

Message cursor: `afterCreatedAt` + `afterId` must be supplied together; default limit 50, max 200. The cursor exists so a client that missed a realtime event can recover without duplicates or gaps.

Lifecycle state machine:

```
ACTIVE ──escalation──▶ WAITING_FOR_HUMAN ──claim/assign──▶ HUMAN_ACTIVE
   ▲                          ▲                                │
   │                          └──────────unassign──────────────┘
   │
   └── customer message on RESOLVED (reopen-to-AI)
RESOLVED ◀── resolve ── any active state
HUMAN_ACTIVE ──agent reopen──▶ from RESOLVED (assigned to actor)
```

AI suppression reasons when a human owns the conversation:

- `AI_BYPASSED` — permanent: a human is handling it.
- `ABORTED` — in-flight turn cancelled because the conversation moved.
- `STALE` — AI answered, but the conversation version changed before the answer was committed.

### 4.8 Public Visitor Surface

Mounted at `/api/v1/public` and deliberately unauthenticated at the router level. The credential is a scoped visitor token.

| Method | Path | Protection |
|---|---|---|
| POST | `/api/v1/public/bots/:botId/conversations` | 10 requests/min per IP |
| POST | `/api/v1/public/conversations/:conversationId/refresh` | Expired token + session secret |
| GET | `/api/v1/public/conversations/:conversationId` | Visitor token |
| GET | `/api/v1/public/conversations/:conversationId/messages` | Visitor token, cursor |
| POST | `/api/v1/public/conversations/:conversationId/messages` | Visitor token, 30/min per token digest |
| POST | `/api/v1/public/conversations/:conversationId/contact` | Visitor token |

Visitor token semantics:

- JWT lifetime 15 minutes.
- Claims name exactly one conversation, bot, and workspace.
- `authenticateVisitor` checks signature, path/conversation match, and live row tenancy on every request.
- A 64-hex session secret is returned once at creation and stored only as a SHA-256 hash.
- Refresh rotates the visitor token only; the session secret is never reissued.
- Public responses omit `senderId`, workspace IDs, assignees, and internal metadata.
- Starting a conversation is the only unauthenticated write with no credential yet, hence the IP limit. Message limiting is keyed on the SHA-256 digest of the token, not on IP, so shared NAT does not punish other customers.

### 4.9 Realtime (Socket.IO)

Socket.IO is attached to the same HTTP server as Express (`app/server/src/server.ts`), so REST and websocket traffic share port `5000` and one shutdown lifecycle.

- Handshake requires a member JWT or visitor token.
- Clients join rooms explicitly with `room:join`; there is no implicit auto-join.
- Authorized rooms: `workspace:<workspaceId>:queue` (agents with `conversations:view`) and `conversation:<conversationId>` (owning visitor or workspace member).
- Unrecognized rooms are rejected; there is no default-allow branch.
- Queue rooms are forbidden to visitor tokens.
- Events:
  - `message:new`
  - `conversation:escalated`
  - `conversation:claimed`
  - `conversation:assigned`
  - `conversation:unassigned`
  - `conversation:resolved`
  - `conversation:reopened`
  - `queue:updated`
- Emissions happen **after** the database transaction commits, never inside it.
- Message broadcasts have two projections: visitor-safe in the conversation room, full record (including `senderId`) in the queue room.
- Removing a workspace member disconnects their sockets after the membership transaction commits.
- With no socket server attached, all emit helpers are no-ops; the REST API remains complete.

### 4.10 AI Catalog, Platform Admin, and AI Lab

Workspace-facing:

- `GET /api/v1/ai/models` — enabled models of enabled providers, without provider-native IDs.

Platform-owner-facing:

- `GET /api/v1/platform/users`
- `GET /api/v1/platform/workspaces`
- `GET /api/v1/platform/system`
- `GET /api/v1/platform/settings`
- `PATCH /api/v1/platform/settings`
- `GET /api/v1/platform/providers`
- `PATCH /api/v1/platform/providers/:providerId`
- `GET /api/v1/platform/models`
- `POST /api/v1/platform/models`
- `PATCH /api/v1/platform/models/:modelId`
- `DELETE /api/v1/platform/models/:modelId`

AI Lab / operations (platform-owner only):

- `GET /api/v1/admin/ai/status`
- `GET /api/v1/admin/ai/ml-status`
- `GET /api/v1/admin/ai/ml-evaluate`
- `POST /api/v1/admin/ai/classify`
- `POST /api/v1/admin/ai/rag/search`
- `POST /api/v1/admin/ai/debug/chat-pipeline`
- `GET /api/v1/admin/ai/testing/status`
- `GET /api/v1/admin/ai/vector-stats`

Catalog rules:

- `providerModelId` and provider `slug` are write-once.
- New models are created disabled.
- A model is selectable only when both model and provider are enabled.
- Provider readiness reports adapter availability and credential presence as separate nullable booleans; no credential crosses the boundary.

### 4.11 Chat Orchestration and Model Resolution

Per turn:

1. Verify conversation access and read lifecycle state.
2. Store the customer message (with optional `clientMessageId`).
3. If `RESOLVED`, perform a customer-driven reopen to `ACTIVE` and clear the assignee.
4. If a human owns the conversation, suppress the AI and return `AI_BYPASSED`.
5. Otherwise start an abortable AI turn, resolve the bot's primary/fallback model, and call the AI service.
6. If the bot is paused, return a normal non-escalating response.
7. If no usable model exists, return a reason-coded fallback without calling the AI service.
8. If the AI signals fallback or insufficient knowledge, move to `WAITING_FOR_HUMAN`.
9. Before committing an AI answer, re-check the conversation version; if it moved, return `STALE` and do not write the answer.
10. Emit message and queue events after commit.

Model failover: primary → configured fallback → AI environment default (only when a bot has no assignment). Model IDs are always resolved from the bot row, never from client input.

### 4.12 Security

- `helmet` headers.
- Configurable CORS allowlist or `*`.
- JSON body limit 1 MB.
- Structured Pino logging with redaction of authorization headers, passwords, and keys.
- Error handler never returns stack traces or database internals.
- AI service authenticated with `X-API-Key`; missing key makes protected AI routes return 503 rather than accept traffic.
- Upload memory limits and permission checks ordered to prevent memory amplification.
- Public visitor surface separately rate-limited and scoped.
- Tenant isolation returns 404 for cross-tenant IDs.
- Conversation event audit is transactional and tenant-scoped.

### 4.13 Server Source Layout

`app/server/src` contains **92 TypeScript files**:

| Directory | Files |
|---|---:|
| `controllers` | 14 |
| `services` | 22 |
| `routes` | 14 |
| `schemas` | 11 |
| `middleware` | 7 |
| `realtime` | 3 |
| `constants` | 6 |
| `types` | 4 |
| `utils` | 6 |
| `config` | 3 |
| root (`app.ts`, `server.ts`) | 2 |

The 22 services are: `aiCatalog`, `aiServiceClient`, `auth`, `authorization`, `avatar`, `bot`, `botConfig`, `botModelResolver`, `businessHours`, `conversation`, `conversationContact`, `escalationPolicy`, `knowledge`, `knowledgeChunk`, `knowledgeSource`, `messageFeedback`, `platform`, `platformSettings`, `sourceLabels`, `user`, `workspace`, `workspaceMember`.

---

## 5. AI Service (FastAPI)

### 5.1 Deterministic Hybrid Pipeline

```
message
  ─▶ CLASSIFY   TF-IDF + LogisticRegression intent classifier
  ─▶ ROUTE      high confidence: topic-filtered search; else full search
  ─▶ RETRIEVE   pgvector cosine similarity, top_k configurable, scoped to bot_id
  ─▶ VALIDATE   no results / low confidence → fallback
  ─▶ GENERATE   LLM grounded strictly in retrieved context
  ─▶ FALLBACK   INSUFFICIENT_INFORMATION → escalate to a human
```

Fallback reasons: `LOW_CLASSIFICATION_CONFIDENCE`, `NO_RELEVANT_KNOWLEDGE`, `LOW_RETRIEVAL_CONFIDENCE`, `LLM_INSUFFICIENT_INFORMATION`.

Thresholds: classification `0.60`, retrieval `0.65`. Chunking: size `800`, overlap `100`.

### 5.2 LLM Providers

Legacy environment path (`LLM_PROVIDER`): OpenAI, Gemini, Grok. Current local default is **Gemini 3.6 Flash**.

Catalog path with five adapters:

| Slug | Adapter | Credential |
|---|---|---|
| `openrouter` | `OpenRouterProvider` | `OPENROUTER_API_KEY` |
| `openai` | `OpenAIProvider` | `OPENAI_API_KEY` |
| `groq` | `GroqProvider` | `GROQ_API_KEY` |
| `gemini` | `GeminiProvider` | `GEMINI_API_KEY` |
| `openai_compatible` | `OpenAICompatibleProvider` | key + base URL |

All adapters implement the `LLMProvider` protocol (`slug`, `is_configured`, `generate`). Registry slugs are unique; adapters load lazily.

Provider errors are classified as `NOT_CONFIGURED`, `AUTH`, `RATE_LIMIT`, `UPSTREAM`, `TIMEOUT`, `BAD_REQUEST`, `UNKNOWN_PROVIDER`, or `UNKNOWN`, and mapped to Node-side fallback reasons.

### 5.3 Embeddings and Cold Start

| Provider | Model | Dimensions | Mode |
|---|---|---|---|
| OpenAI | `text-embedding-3-small` | 1536 | API |
| HuggingFace | `all-MiniLM-L6-v2` | 384 | Local |

Current local configuration uses HuggingFace at 384 dimensions. The model loads lazily on first embedding request:

- Cold load measured at **34.7 s**.
- Warm embedding measured at **0.6 s**.
- A 12-page PDF was ingested into 3 chunks in **582 ms** once warm.

This cold start is the reason the server's AI timeout must exceed 30 s.

### 5.4 ML Components

- Intent classifier: TF-IDF + LogisticRegression, trained from `app/Ai/app/ml/training/training_data.csv`.
- Escalation model: separate feature/model/predict modules.
- Training: `python -m app.ml.training.train`.
- Evaluation: `GET /api/v1/ml/evaluate` (through the server: `/api/v1/admin/ai/ml-evaluate`).

### 5.5 RAG Components

| Component | Location |
|---|---|
| Pipeline coordination | `app/rag/pipeline.py` |
| Loaders / cleaners / chunker | `app/rag/ingestion/` |
| Retriever / metadata | `app/rag/retrieval/` |
| Generator / prompts | `app/rag/generation/` |
| Document extraction service | `app/services/document_service.py` |
| Chunking service | `app/services/chunking_service.py` |

### 5.6 API Route Files

| File | Endpoints |
|---|---|
| `health.py` | `GET /health` |
| `ai.py` | `GET /status`, `POST /chat` |
| `chat.py` | `POST /chat` |
| `knowledge.py` | ingest, ingest-document, chunk re-embed/toggle/delete, bulk operations, source delete, bot knowledge delete |
| `classifier.py` | `POST /classify`, `GET /status`, `GET /evaluate` |
| `rag.py` | `POST /search` |
| `testing.py` | `GET /status`, `GET /vector-store/stats`, `POST /chat-pipeline` |

The server proxies the protected ones; the public client never calls this service.

### 5.7 Services Layer

14 service modules:

`chat_service`, `chunking_service`, `classifier_service`, `document_service`, `embedding_service`, `escalation_service`, `fallback_service`, `knowledge_service`, `llm_service`, `ml_service`, `rag_service`, `retrieval_service`, `vector_store_service`, plus the package init.

### 5.8 Security and Tenancy

- `X-API-Key` required on protected routes.
- Every vector query filters by `bot_id`.
- Provider credentials live only in environment variables, never in the database or browser.
- Credential redaction in logs (`app/core/redaction.py`).
- JSON logging optional via `LOG_FORMAT=json`.
- No disabled mode: a missing API key means 503, not open access.

### 5.9 Experimental Agent

`app/agents/` contains a LangGraph-based graph, nodes, and state. It is not the production path; the deterministic pipeline is.

---

## 6. Client (Next.js)

### 6.1 Route Map

The primary app lives under `/w/[workspaceId]`:

| Route | Purpose |
|---|---|
| `/` | Landing / entry |
| `/login` | Login |
| `/register` | Registration |
| `/home` | Global home and workspace selection |
| `/w/[workspaceId]` | Workspace dashboard: bots, active count, unassigned queue |
| `/w/[workspaceId]/bots` | Bot list and create-bot dialog |
| `/w/[workspaceId]/bots/[botId]` | Bot overview |
| `/w/[workspaceId]/bots/[botId]/configure` | Full tabbed configuration surface |
| `/w/[workspaceId]/bots/[botId]/knowledge` | FAQ, sources, chunks, retrieval test |
| `/w/[workspaceId]/bots/[botId]/knowledge/sources/[sourceId]` | Source detail and chunk viewer |
| `/w/[workspaceId]/bots/[botId]/conversations` | Per-bot conversations |
| `/w/[workspaceId]/inbox` | Workspace support inbox |
| `/widget/[botId]` | Standalone public customer chat widget |

Platform routes remain at `/platform`, `/platform/models`, `/platform/ai-lab`, `/platform/settings`, `/platform/users`, `/platform/system`, `/platform/workspaces`.

The old `/dashboard/*` routes still exist as compatibility bridges:

- `/dashboard` and `/dashboard/workspaces` → `/home`.
- `/dashboard/workspaces/[workspaceId]` → `/w/[workspaceId]/bots`.
- `/dashboard/workspaces/[workspaceId]/inbox` → `/w/[workspaceId]/inbox`.
- `/dashboard/bots/[botId]` resolves the bot and redirects to the corresponding `/w/...` route.
- The remaining legacy bot knowledge/conversation pages use `LegacyBotRedirect`.

### 6.2 Support Inbox

`/w/[workspaceId]/inbox` is a full agent workspace:

- Queue tabs: unassigned, assigned to me, all active, resolved.
- Real-time queue updates and message delivery through Socket.IO.
- Conversation transcript, contact panel, feedback display.
- Claim, assign, unassign, resolve, reopen.
- Agent composer that posts `/reply` as an `AGENT` message.
- Cursor-based message recovery after a socket drop.
- Read-only behavior for roles without the required permissions.

### 6.3 Public Widget

`components/widget/CustomerChatWidget.tsx` provides:

- Start/resume a visitor session per bot, keyed in localStorage.
- 15-minute visitor token with automatic refresh using the stored session secret.
- Optimistic user bubbles reconciled by `clientMessageId`.
- Suggested questions, thinking messages, welcome content, bot avatar.
- Streaming-like "thinking" display while the blocking request runs.
- Source citations when enabled.
- Escalation state and agent takeover awareness.
- Contact collection when configured.
- Realtime `message:new` and lifecycle events.
- Message recovery via the cursor endpoint.
- Standalone mode on `/widget/[botId]` and embeddable preview inside bot configuration.

There is no one-line embeddable loader script or iframe snippet generator yet. The hosted `/widget/[botId]` page is the integration surface.

### 6.4 Bot Configuration UI

19 colocated components under `app/Client/app/w/[workspaceId]/bots/[botId]/_components/`:

`bot-config-tabs`, `general-tab`, `appearance-tab`, `avatar-uploader`, `bot-avatar`, `personality-tab`, `ai-model-tab`, `conversation-tab`, `knowledge-tab`, `human-support-tab`, `business-hours-editor`, `contact-fields-editor`, `suggested-questions-editor`, `thinking-messages-editor`, `preview-panel`, `chat-message`, `unsaved-changes-bar`, `config-options`, `tab-props`.

### 6.5 Knowledge UI

8 colocated components:

`faq-tab`, `sources-tab`, `chunks-tab`, `retrieval-tab`, `upload-dialog`, `chunk-editor-dialog`, `stats-cards`, `status-badge`.

### 6.6 Shared Components

`app/Client/components/` has **32 files**:

- 20 shared UI primitives: button, input, textarea, select, checkbox, radio-group, slider, switch, field, file-input, search-input, card, badge, tabs, dialog, confirm-dialog, toast, spinner, empty-state, pagination.
- 11 app-level components: api-error-bridge, app-shell, auth-guard, breadcrumbs, global-shell, legacy-bot-redirect, page-header, platform-guard, sidebar, workspace-shell, workspace-switcher.
- 1 widget component: `widget/CustomerChatWidget.tsx`.

The inbox adds 7 colocated components (queue sidebar, conversation card, transcript, chat bubble, composer, assign modal, contact panel), and the bot list adds a create-bot dialog.

### 6.7 Client Infrastructure

`app/Client/lib` has **18 files**:

- `api-client.ts`
- `auth-context.tsx`
- `workspace-context.tsx`
- `socket.ts`
- `permissions.ts`
- `format.ts`
- 12 API modules: `auth`, `workspaces`, `bots`, `botConfig`, `knowledge`, `knowledgeSources`, `knowledgeChunks`, `conversations`, `models`, `ai`, `platform`, `publicChat`.

Notable behavior:

- API client injects member JWTs and normalizes errors.
- Auth guard and platform guard protect routes.
- Workspace provider loads membership, role, and permissions once per workspace and exposes `hasPermission`.
- Socket singleton re-authenticates when the token changes and is disconnected on logout.
- Client permissions mirror the server matrix.

---

## 7. Test and Verification Results (2026-10-26)

### 7.1 Automated Suites

| Suite | Result | Files |
|---|---|---|
| Server (Vitest + Supertest) | **800 passed** | 34 suites, 35 files including `setup.ts` |
| AI (pytest + TestClient) | **644 passed** | 20 test modules |
| Client (Vitest + Testing Library) | **59 passed** | 15 files |

The server suite mocks Prisma and the AI client; the AI suite drives FastAPI through `TestClient` with provider/vector boundaries mocked. Neither requires the other service to be running. Client tests cover auth/home routing, bot config, business hours, avatar, preview, inbox, widget, navigation, theme tokens, and read-only modes.

### 7.2 Production Builds

- `app/server`: `npm run build` (`tsc`) succeeded.
- `app/Client`: `next build` succeeded.

### 7.3 Live Ingestion Verification

Verified against the running server, AI service, native PostgreSQL, and pgvector:

- Valid PDF and DOCX uploaded in one batch → both reached `PROCESSED`.
- 12-page PDF → 3 chunks; warm processing time **582 ms**.
- Chunk embeddings stored as 384-dimensional vectors using `all-MiniLM-L6-v2`.
- Source list/detail, chunk list/stats, retrieval test, chunk content edit with re-embed, source delete, and FAQ ingestion all verified.
- Corrupt PDF → that file alone became `FAILED` with `"Failed to process PDF file: startxref not found"`; its sibling still succeeded; the batch returned HTTP 201.
- Cold embedding load: **34.7 s**; warm: **0.6 s**.

### 7.4 Chat Verification

- After raising `AI_SERVICE_TIMEOUT` to 120000 ms, chat returned HTTP 201 with grounded answers in roughly **6 s** on a warm model path.
- A contradictory-context case correctly triggered a fallback instead of hallucinating. The test corpus had overlapping chunks stating 45 days and 35 days after an edit; this was correct conservative behavior, not a pipeline bug.
- Model latency benchmarks with a simple prompt:
  - `gemini-3.6-flash`: 8.3 s simple prompt, 31-68 s full RAG pipeline.
  - `gemini-3.8-flash`: 160.5 s.
  - `gemini-flash-lite-latest`: 1.4 s.
  - `gemini-3.1-flash-lite`: 1.7 s.

### 7.5 Root Cause of the Old Ingestion Failures

The four 2026-10-21 failures were not chunking or document-parsing failures. They all stored the generic AI-unavailable message, which is emitted only when the Node server cannot complete the AI request. The cold HuggingFace model load took about 35 s, while the server's AI timeout was 30 s. The request aborted before the AI service could finish. Raising the timeout to 120 s fixed valid ingestion.

### 7.6 Cleanup

All test-created users, workspaces, bots, sources, chunks, vectors, conversations, and messages were removed. The database was restored to the counts shown in section 0. The temporary `assistiq-postgres` container was removed. The `assistiq-pgvector` container remains.

---

## 8. What Works End to End

1. Registration, login, JWT-protected routes.
2. Platform and workspace RBAC with 404-not-403 isolation.
3. Workspace creation, listing, member management.
4. Bot CRUD, configuration, avatar upload/serve/delete.
5. Primary and fallback model assignment and failover.
6. FAQ knowledge create/list/update/delete with AI sync.
7. PDF/DOCX upload, extraction, chunking, embedding, pgvector storage.
8. Source and chunk management, bulk operations, re-embedding, retrieval testing.
9. Grounded RAG chat with intent classification and conservative fallback.
10. Human escalation with reason codes, status transition, business-hours awareness.
11. Support queue, claim/assign/unassign/resolve/reopen, durable event audit.
12. Agent replies and customer-visible agent messages.
13. Message feedback and contact collection.
14. Real-time queue/message/lifecycle updates through Socket.IO.
15. Public visitor chat with scoped tokens, refresh, rate limits, and transcript recovery.
16. Hosted customer widget at `/widget/[botId]`.
17. Multi-provider model catalog and platform administration.
18. AI Lab status, ML evaluation, vector stats, pipeline debugging.
19. Platform settings for upload/chunk limits.
20. Production builds for server and client.

---

## 9. Explicitly Not Implemented / Deferred

| Feature | Current state |
|---|---|
| **Streaming responses** | Chat is a blocking request/response. Socket.IO carries committed messages, not token deltas. The widget shows thinking messages while waiting. |
| **Conversation memory** | The AI receives only the current message plus bot config. Prior turns are stored but not sent to the model. |
| **Server-side logout / token revocation** | Logout is client-side only. Member JWTs are valid until expiry. Visitor tokens expire in 15 minutes and cannot be individually revoked. |
| **User refresh tokens** | Member auth is a single 7-day JWT. Visitor token refresh exists and is separate. |
| **Workspace update/delete endpoints** | Permissions and role grants exist, but no routes/services are wired. |
| **Billing** | `billing:view` / `billing:manage` permissions exist; no models, routes, or UI. |
| **Audit table for platform/catalog changes** | Conversation lifecycle has a durable event table. Provider/model/platform changes are logged only. |
| **Live provider reachability** | Readiness reports adapter availability and credential presence; it does not make a live provider call. |
| **Embeddable widget loader / iframe snippet** | Hosted widget page exists; no generated embed script or snippet UI. |
| **Conversation list pagination** | Queue, messages, sources, and chunks are paginated. `GET /bots/:botId/conversations` still returns the full list. |
| **File types beyond PDF/DOCX** | No TXT, Markdown, HTML, or spreadsheet ingestion. |
| **Configuration history / rollback** | Bot config has optimistic concurrency only; no diff/version history. |
| **Global API rate limiting** | Only auth and public visitor routes have explicit limits. |
| **Production-grade CORS/secrets** | Local `.env` uses `CORS_ORIGIN="*"` and development secrets. |

---

## 10. Project File Counts

| Area | Files | Notes |
|---|---:|---|
| Server source (`app/server/src`) | 92 TS files | 14 controllers, 22 services, 14 routes, 11 schemas, 7 middleware, 3 realtime |
| Server tests | 35 files | 34 suites + `setup.ts`; 800 tests |
| AI source (`app/Ai/app`) | 82 Python files | 14 services, 8 route files, 5 providers + registry/base/wire, RAG/ML/agents |
| AI tests | 22 Python files | 20 test modules + `conftest.py` + `__init__.py`; 644 tests |
| Client app | 70 files | 28 `page.tsx` routes + layouts, CSS, colocated components |
| Client shared components | 32 files | 20 UI primitives + 11 app components + widget |
| Client lib | 18 files | 12 API modules + client/context/socket/permissions/format |
| Client tests | 15 files | 59 tests |
| Prisma schema | 1 file, 656 lines | 16 models, 13 enums |
| Migrations | 6 | Additive; human escalation is the newest |
| Design/implementation docs | 6 files in `docs/` | Bot, documents, frontend revamp, human escalation, model, RBAC |

---

## 11. Running the Project

### Prerequisites

- Node.js 22.x
- Python 3.14.x (global install currently used; the AI `.venv` is a stub)
- PostgreSQL on `5432` with `assistiq_db`
- pgvector PostgreSQL on `5433` (container `assistiq-pgvector`)

### Database

```bash
# Native PostgreSQL must already be running on 5432.
cd app/server
npx prisma migrate deploy
npx prisma generate
npm run db:seed        # optional seed/RBAC data
```

Do **not** start `app/server/docker-compose.yml` while native PostgreSQL is bound to 5432.

### AI service

```bash
cd app/Ai
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Use the global Python 3.14 install. Installing into `app/Ai/.venv` would require recreating it; the current venv has only pip.

### Server

```bash
cd app/server
npm run dev
```

### Client

```bash
cd app/Client
npm run dev
```

### Tests and builds

```bash
cd app/server && npm test && npm run build
cd app/Ai && python -m pytest
cd app/Client && npm test && npm run build
```

On this Windows setup, the `npm` and Docker shims may fail because `/usr/bin` is missing from the bash PATH. Use the absolute `npm.cmd` path or run from PowerShell if needed.

---

## 12. Git State

- HEAD: `96a6fc1 UI revamp and major changes to ux`
- Before this document update, the tracked tree was clean.
- `IDEA.md` is untracked.
- `app/server/.env` contains the local `AI_SERVICE_TIMEOUT=120000` change; `.env` is gitignored.
- This document update is the only tracked file changed by the 2026-10-26 verification work.

---

## 13. License

ISC
