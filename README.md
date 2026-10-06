<p align="center">
  <h1 align="center">AssistIQ</h1>
  <p align="center">
    <strong>Multi-tenant, AI-powered customer support SaaS</strong>
  </p>
  <p align="center">
    RAG pipeline · Intent classification · Human escalation · RBAC · Model catalog
  </p>
</p>

---

## What is AssistIQ?

AssistIQ is a platform where businesses create **Workspaces**, build **Bots**, fill them with **Knowledge** (FAQ entries or documents), and let those bots answer customer questions in real time. The AI pipeline is designed to **never hallucinate** — it retrieves grounded context, generates strictly from it, and escalates to a human when it can't help.
---

## Architecture Overview

AssistIQ is a **monorepo** with three independently runnable services under [`app/`](app/):

| Service | Stack | Port | Role |
|---------|-------|------|------|
| [**Client**](app/Client/) | Next.js 16, React 19, Tailwind v4 | `3000` | User-facing dashboard & chat UI |
| [**Server**](app/server/) | Node 20, Express 4, Prisma 6, PostgreSQL 16 | `5000` | API orchestrator, auth, business logic, tenant isolation |
| [**AI**](app/Ai/) | Python 3.12, FastAPI, LangChain, pgvector, scikit-learn | `8000` | RAG pipeline, ML classification, LLM generation |

### How They Connect

```
   Browser
      │
      ▼
┌─────────────┐   /api/v1/*    ┌──────────────┐   /api/v1/chat   ┌──────────────┐
│   Client    │ ──────────────▶│    Server    │ ────────────────▶│      AI      │
│  Next.js    │  Bearer JWT    │   Express    │   X-API-Key       │   FastAPI    │
│   :3000     │◀────────────── │    :5000     │◀──────────────── │    :8000     │
└─────────────┘                └──────┬───────┘                  └──────┬───────┘
                                      │                                 │
                                      │ Prisma                          │ asyncpg
                                      ▼                                 ▼
                              ┌───────────────────────────────────────────────┐
                              │      PostgreSQL 16  +  pgvector extension      │
                              │  Relational data (Prisma)  |  Vectors (RAG)    │
                              └───────────────────────────────────────────────┘
```

> **The browser never talks to the AI service.** All AI communication is proxied through the Server. The AI service is a private backend-for-backend, keeping it off the public internet.

---

## Data Model

Ownership is **transitive** down a single chain — tenant isolation follows this hierarchy:

```
User ──owns──▶ Workspace ──has──▶ Bot ──has──▶ KnowledgeEntry
                  │                  ├─has──▶ KnowledgeSource ──has──▶ KnowledgeChunk
                  │                  ├─has──▶ Conversation ──has──▶ Message
                  │                  └─has──▶ BotConfiguration
                  └──has──▶ WorkspaceMember (RBAC)

AIProvider ──has──▶ AIModel (platform catalog)
```

Every ownership check is enforced **in a single Prisma query** whose `WHERE` clause embeds the full ownership join. A cross-tenant ID returns `null` → **404** (never 403), so the API doesn't even leak that the resource exists.

---

## The AI Pipeline

The deterministic hybrid pipeline that powers every chat response:

```
message ─▶ 1. CLASSIFY   TF-IDF + LogisticRegression intent classifier
         ─▶ 2. ROUTE      high confidence → topic-filtered search; else full search
         ─▶ 3. RETRIEVE   pgvector cosine similarity, top_k=3, scoped to bot_id
         ─▶ 4. VALIDATE   zero results → fallback (NO_RELEVANT_KNOWLEDGE)
         ─▶ 5. GENERATE   LLM at temperature=0.0, grounded strictly in retrieved context
         ─▶ 6. FALLBACK   LLM emits INSUFFICIENT_INFORMATION → escalate to human
```

**Fallback reason codes:** `LOW_CLASSIFICATION_CONFIDENCE`, `NO_RELEVANT_KNOWLEDGE`, `LOW_RETRIEVAL_CONFIDENCE`, `LLM_INSUFFICIENT_INFORMATION`

When fallback is triggered, the conversation status flips to `WAITING_FOR_HUMAN`.

### LLM & Embedding Providers

| LLM Providers | Embedding Providers |
|---------------|---------------------|
| OpenAI (`gpt-4o-mini`) | OpenAI (`text-embedding-3-small`, 1536d) |
| Gemini (`gemini-2.0-flash`) | HuggingFace (`all-MiniLM`, 384d, local) |
| Grok (`grok-3-mini`) | |

**Model Catalog** — a platform-owner curated catalog supporting **OpenRouter**, **OpenAI**, **Groq**, **Gemini**, and a **generic OpenAI-compatible** slot (for Together, Fireworks, Ollama, etc.). Bots can be assigned catalog models; unassigned bots use the environment default.

> To run completely free: set `LLM_PROVIDER=gemini` + `EMBEDDING_PROVIDER=huggingface`.

---

## Authorization (RBAC)

Two independent authorization domains:

| Domain | Roles | Scope |
|--------|-------|-------|
| **Platform** | `USER`, `PLATFORM_OWNER` | Global — controls AI lab, model catalog, platform admin |
| **Workspace** | `OWNER`, `ADMIN`, `AGENT` | Per-workspace — controls bots, knowledge, conversations |

A `PLATFORM_OWNER` who is only an `AGENT` in a workspace stays an `AGENT` there. The two domains never cross.

---

## Quick Start

### Prerequisites

- **Node.js 20+** and npm
- **Python 3.12+**
- **Docker** (for PostgreSQL + pgvector)

### 1. Database

```bash
# Start PostgreSQL (relational data)
cd app/server && docker compose up -d        # port 5432

# Start pgvector (vector store)
cd app/Ai && docker compose up -d            # port 5433
```

### 2. AI Service

```bash
cd app/Ai
python -m venv .venv
.venv\Scripts\activate                        # Windows
# source .venv/bin/activate                   # macOS/Linux
pip install -r requirements.txt
cp .env.example .env                          # fill in API keys (or use gemini + huggingface for free)
python -m app.ml.training.train               # REQUIRED — trains the intent classifier
uvicorn app.main:app --reload --port 8000
```

### 3. Server

```bash
cd app/server
npm install
cp .env.example .env                          # set DATABASE_URL, JWT_SECRET, AI_SERVICE_URL, AI_SERVICE_API_KEY
npm run prisma:generate && npm run prisma:migrate
npm run db:seed                               # seeds RBAC data + promotes PLATFORM_OWNER_EMAIL if set
npm run dev                                   # port 5000
```

### 4. Client

```bash
cd app/client
npm install
# optional: create .env.local with NEXT_PUBLIC_API_URL=http://localhost:5000/api/v1
npm run dev                                   # port 3000
```

### Verify

```bash
curl http://localhost:5000/health   # Server
curl http://localhost:8000/health   # AI service
# Client: open http://localhost:3000
```

---

## Key Features

### ✅ Working End-to-End

- **Auth** — Registration, login, JWT-protected routes, stateless logout
- **Multi-tenancy** — Strict workspace isolation verified by tests
- **Workspace / Bot / Knowledge CRUD** — Full lifecycle with cascading deletes
- **Chat with AI** — Deterministic RAG pipeline with intent classification and human escalation
- **Document ingestion** — PDF/DOCX → text extraction → chunking → embedding → pgvector
- **Model catalog** — Platform-owner curated, multi-provider model selection per bot
- **Bot configuration** — Personality, tone, generation params, knowledge strictness, business hours
- **RBAC** — Platform roles + workspace roles with permission matrix
- **AI Lab** — Operations console for ML evaluation, vector stats, pipeline debugging
- **Platform admin** — Provider management, model catalog, system settings, user management
- **Message feedback** — Thumbs up/down with reason codes on assistant messages

### 🚧 Explicitly Deferred

- **Human handoff routing** — Status is set to `WAITING_FOR_HUMAN`, but no agent routing exists yet
- **Streaming** — Chat responses are blocking round-trips; no SSE/WebSocket streaming
- **Conversation memory** — Only the current message is sent to the AI; prior turns are not included
- **Server-side logout** — No token blacklist; logout is client-side only
- **Pagination** — Not implemented on any list endpoint

---

## Project Structure

```
AssistIQ/
├── README.md                 ← you are here
├── app/
│   ├── client/               Next.js frontend (see app/client/README.md)
│   │   ├── app/              Pages (App Router)
│   │   │   ├── dashboard/    Workspaces, bots, knowledge, conversations
│   │   │   ├── platform/     Platform admin (models, providers, settings, users)
│   │   │   ├── login/
│   │   │   └── register/
│   │   ├── components/       Reusable UI components
│   │   └── lib/              API client, auth context, permissions
│   │
│   ├── server/               Express backend (see app/server/README.md)
│   │   ├── prisma/           Schema, migrations, seed
│   │   ├── src/
│   │   │   ├── config/       Env validation, DB singleton, logger
│   │   │   ├── middleware/   Auth, validation, RBAC authorization, error handling
│   │   │   ├── services/     Business logic + DB access + ownership checks
│   │   │   ├── controllers/  Thin request handlers
│   │   │   ├── routes/       Endpoint wiring
│   │   │   └── schemas/      Zod validation schemas
│   │   └── tests/            Vitest suites (auth, workspace, bot, conversation, RBAC)
│   │
│   └── Ai/                   FastAPI AI service (see app/Ai/README.md)
│       ├── app/
│       │   ├── api/          Route handlers
│       │   ├── services/     Chat, retrieval, embedding services
│       │   ├── providers/    LLM provider adapters (OpenRouter, OpenAI, Groq, Gemini, generic)
│       │   ├── ml/           Intent classifier, escalation model, training data
│       │   ├── rag/          Chunking, ingestion, document loaders
│       │   ├── agents/       LangGraph pipeline (experimental)
│       │   └── core/         Config, constants, redaction
│       ├── models/           Trained ML artifacts (.joblib)
│       └── tests/
│
└── docs/                     Implementation plans
    ├── BOT_IMPLEMENTATION_PLAN.md
    ├── DOCUMENT_KNOWLEDGE_IMPLEMENTATION_PLAN.md
    ├── Model_IMPLEMENTATION_PLAN.md
    └── RBAC_IMPLEMENTATION_PLAN.md
```

---

## Component READMEs

Each service has its own detailed README with setup, configuration, API reference, and architecture:

| Component | README | What You'll Find |
|-----------|--------|------------------|
| **Server** | [`app/server/README.md`](app/server/README.md) | Full API reference, environment variables, Prisma schema, RBAC details, testing guide, auth flow, AI service boundary |
| **AI Service** | [`app/Ai/README.md`](app/Ai/README.md) | Pipeline architecture, provider layer & model catalog, adapter contract, failure handling, environment variables, multi-tenancy |
| **Client** | [`app/client/README.md`](app/Client/README.md) | Next.js setup and development |

---

## Environment Variables (Quick Reference)

### Server (`app/server/.env`)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `JWT_SECRET` | **yes** | — | ≥ 16 chars |
| `AI_SERVICE_URL` | no | — | Python service URL (e.g. `http://localhost:8000`) |
| `AI_SERVICE_API_KEY` | **yes** | — | Shared secret with AI service |
| `CORS_ORIGIN` | no | `*` | Comma-separated allowlist |

### AI Service (`app/Ai/.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `LLM_PROVIDER` | `openai` | `openai` \| `gemini` \| `grok` |
| `LLM_API_KEY` | `""` | API key for the chosen LLM provider |
| `EMBEDDING_PROVIDER` | `openai` | `openai` (1536d) \| `huggingface` (384d, local) |
| `DATABASE_URL` | `postgresql://...` | Must point at the pgvector database |

### Client (`app/client/.env.local`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:5000/api/v1` | Server API base URL |

> See each component's README for the full variable list.

---

## Testing

| Component | Command | Approach |
|-----------|---------|----------|
| **Server** | `cd app/server && npm test` | Vitest + Supertest; Prisma & AI mocked → **no DB, no Python needed** |
| **AI** | `cd app/Ai && pytest` | FastAPI TestClient |
| **Client** | `cd app/client && npm test` | Vitest + React Testing Library |

The server test suite is the most comprehensive, covering auth, tenant isolation, RBAC matrix, AI catalog lifecycle, and cross-tenant denial.

---

## API Endpoints (Summary)

Base path: `/api/v1` — All responses use `{ success, message, data }` envelope.

| Group | Key Endpoints | Auth |
|-------|---------------|------|
| **Auth** | `POST /auth/register`, `POST /auth/login` | 🔓 Public |
| **Users** | `GET /users/me` | 🔒 JWT |
| **Workspaces** | CRUD on `/workspaces` | 🔒 JWT |
| **Bots** | CRUD on `/workspaces/:id/bots`, `/bots/:id` | 🔒 JWT + workspace role |
| **Knowledge** | CRUD on `/bots/:id/knowledge`, document upload | 🔒 JWT + workspace role |
| **Conversations** | Create, list, get, send messages | 🔒 JWT + workspace role |
| **AI Models** | `GET /ai/models` (workspace view) | 🔒 JWT |
| **Platform** | Provider/model management under `/platform/*` | 🔒 PLATFORM_OWNER |
| **AI Admin** | AI Lab proxies under `/admin/ai/*` | 🔒 PLATFORM_OWNER |

> See [`app/server/README.md`](app/server/README.md) for the complete API reference with request/response shapes.

---

## Security Highlights

- **Tenant isolation via query-level scoping** — ownership embedded in every Prisma `WHERE` clause
- **Cross-tenant requests return 404, never 403** — resource existence is never leaked
- **JWT auth with bcrypt (12 rounds)** — login never reveals whether an email exists
- **AI service authenticated via `X-API-Key`** — no unauthenticated access
- **Provider credentials stay in the AI service** — never stored in the database, never sent to the browser
- **Structured logging with credential redaction** — Authorization headers, passwords, and API keys are automatically scrubbed
- **Security headers** via `helmet`, rate limiting on auth routes, configurable CORS

---

## License

ISC
