# AssistIQ — Project Understanding

> Compiled by reading every project markdown file (`app/currentImplementation.md`, `app/server/README.md`,
> `app/server/endpoints.md`, `app/Ai/README.md`, `app/Ai/enpoints.md`, `app/client/README.md`,
> `app/client/AGENTS.md`, `app/client/CLAUDE.md`) and then **verifying each claim against the source code**.
>
> Where the docs and the code disagree, the docs are stale. Section 8 lists every drift found — read it
> before trusting any of the other markdown files in this repo.

---

## 1. What AssistIQ Is

AssistIQ is a **multi-tenant, AI-powered customer-support SaaS**. A customer signs up, creates a
**Workspace**, creates **Bots** inside it, fills each bot with **Knowledge (FAQ)** entries, and then has
**Conversations** with that bot. The bot answers from the ingested knowledge using a RAG pipeline, and is
designed to say "I don't know" rather than hallucinate — escalating to a human when it can't help.

Two ideas drive the whole design:

1. **Strict tenant isolation.** A user must never be able to read or write another user's data. This is
   enforced at the database-query level, not just in UI or middleware (see §4).
2. **No hallucinations.** The AI pipeline is deliberately *deterministic* first: a trained ML classifier
   routes the query, vector search retrieves grounded context, and only then does an LLM generate an
   answer *strictly from that context* — with explicit fallback signals at every stage.

The codebase says it is at **"Review 1"** stage throughout: a foundation built to a spec, with a
documented "Review 2 roadmap" of what was intentionally deferred.

---

## 2. Repository Layout

A monorepo with three independently runnable components under `app/`:

```
AssistIQ/
└── app/
    ├── client/     Next.js 16 / React 19 / Tailwind v4   →  port 3000
    ├── server/     Node 20 / Express / Prisma / Postgres →  port 5000
    ├── Ai/         Python 3.12 / FastAPI / pgvector      →  port 8000
    └── currentImplementation.md
```

There is **no root-level package.json, no root README, no workspace tooling**. Each component is installed
and run separately. `app/currentImplementation.md` is the only file that talks about all three at once.

### Runtime topology

```
   Browser
      │
      ▼
┌─────────────┐   /api/v1/*    ┌──────────────┐   /api/v1/chat   ┌──────────────┐
│   client    │ ──────────────▶│    server    │ ────────────────▶│      Ai      │
│  Next.js    │  Bearer JWT    │   Express    │  (no auth hdr)   │   FastAPI    │
│   :3000     │◀────────────── │    :5000     │◀──────────────── │    :8000     │
└─────────────┘                └──────┬───────┘                  └──────┬───────┘
                                      │                                 │
                                      │ Prisma                          │ asyncpg
                                      ▼                                 ▼
                              ┌───────────────────────────────────────────────┐
                              │      PostgreSQL 16  +  pgvector extension      │
                              │  users/workspaces/bots/knowledge_entries/      │
                              │  conversations/messages   |   knowledge_chunks │
                              └───────────────────────────────────────────────┘
```

**The browser never talks to the AI service.** It only talks to `server`. The AI service is a private
backend-for-backend reached exclusively by `server`. The client's `/admin/ai/*` calls are proxied by
`server` — that keeps the AI service off the public internet (in intent, at least — see §8.6).

---

## 3. The Three Components

### 3.1 `app/server` — the orchestrator

**Stack:** Node 20+, TypeScript (strict, ESM + NodeNext), Express 4, Prisma 6, PostgreSQL 16, Zod,
Pino, helmet, cors, express-rate-limit, bcryptjs, jsonwebtoken, multer. Tests: Vitest + Supertest.

This is the only component that owns business logic, auth, and the relational schema. It is the source of
truth for tenancy.

**Layering rule (enforced by convention):** `routes → controllers → services → prisma`.
Controllers are thin (read input → call one service → send response). Services own all business logic, all
DB access, and all ownership checks. Controllers never touch Prisma.

**Data model** (`prisma/schema.prisma`) — ownership is transitive down a single chain:

```
User ──owns──▶ Workspace ──has──▶ Bot ──has──▶ KnowledgeEntry
                                    └─has──▶ Conversation ──has──▶ Message
```

| Model | Key fields | Notes |
| --- | --- | --- |
| `User` | `id` (uuid), `name`, `email` (unique), `passwordHash` | `@@map("users")` |
| `Workspace` | `id`, `name`, `ownerId` | single-owner model — no membership table |
| `Bot` | `id`, `name`, `description?`, `workspaceId` | |
| `KnowledgeEntry` | `id`, `title?`, `category?`, `question`, `answer`, `botId` | the FAQ/RAG source |
| `Conversation` | `id`, `botId`, `status`, `assignedAgentId?` | status: `ACTIVE` \| `WAITING_FOR_HUMAN` \| `RESOLVED` |
| `Message` | `id`, `conversationId`, `role`, `content` | role: `USER` \| `ASSISTANT` \| `SYSTEM` |

Every FK is `onDelete: Cascade`, so deleting a Bot removes its knowledge, conversations and messages in
one operation. All foreign keys are indexed.

**Auth:** JWT bearer tokens. `sub` = user id. bcryptjs with 12 salt rounds. Login returns one generic
`Invalid email or password` for both unknown-email and wrong-password, so the API never leaks which emails
exist. Logout is **client-side only** — the token is stateless and simply discarded; a server-side
blacklist is explicitly deferred to Review 2 rather than faked.

**AI boundary:** all communication with Python lives in exactly one file,
[`aiServiceClient.ts`](app/server/src/services/aiServiceClient.ts), a singleton class exposing typed methods
(`chat`, `ingestKnowledge`, `deleteBotKnowledge`, `classifyIntent`, `ingestDocument`, plus the
`/admin/ai/*` proxies). It uses `AbortSignal.timeout` — 30 s for normal calls, 90 s for file uploads — and
maps any failure to a **502** with a generic message, never leaking internals.

**Chat orchestration** lives in [`conversation.service.ts`](app/server/src/services/conversation.service.ts):

```
addMessage(conversationId, ownerId, content):
  1. assert the conversation belongs to the caller   (else 404)
  2. INSERT the USER message
  3. POST /api/v1/chat to the Python service  { bot_id, message }
  4. if ai.fallback_required → set conversation.status = WAITING_FOR_HUMAN
  5. INSERT the ASSISTANT message from ai.response
  6. return { userMessage, assistantMessage, ai }
```

**Security hardening:** `helmet`, configurable CORS, 1 MB JSON body limit, auth routes rate-limited to
20 req/15 min per IP, and a Pino logger that redacts `Authorization`/`Cookie` headers and any
`password` / `passwordHash` / `token` field. The centralized error handler maps `AppError` / Zod / Prisma
errors to correct status codes and never returns stack traces in production.

**Tests** mock Prisma and the AI client (`vi.mock`), so `npm test` needs no database and no Python service.
Coverage: auth (register/duplicate/invalid/login/protected), workspace (owner from token, cross-tenant
404), bot (parent-ownership assertion, cross-tenant 404), conversation (USER+ASSISTANT stored, AI called
once, cross-tenant → 404 *and AI never called*, empty message → 400).

### 3.2 `app/Ai` — the intelligence layer

**Stack:** Python 3.12, FastAPI, pydantic-settings, LangChain + LangGraph, pgvector (raw `asyncpg`, not an
ORM), scikit-learn, sentence-transformers, pypdf, python-docx.

A **stateless** microservice. It holds no user data of its own — everything it knows lives in the shared
Postgres `knowledge_chunks` table and in joblib model files on disk (`models/intent_classifier.joblib`,
`models/tfidf_vectorizer.joblib`). All state is addressed by `bot_id`.

#### The pipeline the server actually uses: `/api/v1/chat`

Implemented by [`chat_service.py`](app/Ai/app/services/chat_service.py) — the **deterministic hybrid**
pipeline. This is the one wired into the product:

```
message ─▶ 1. CLASSIFY   TF-IDF + LogisticRegression intent classifier
         ─▶ 2. ROUTE      if confident && intent != GENERAL_SUPPORT → topic_filter; else full search
         ─▶ 3. RETRIEVE   pgvector cosine search, top_k=3, WHERE bot_id = $1 [AND topic = $n]
         ─▶ 4. VALIDATE   no results → fallback(NO_RELEVANT_KNOWLEDGE), stop
         ─▶ 5. GENERATE   LLM at temperature=0.0, grounded strictly in retrieved chunks
         ─▶ 6. FALLBACK   if the LLM emits the literal "INSUFFICIENT_INFORMATION" signal
                          → fallback(LLM_INSUFFICIENT_INFORMATION)
```

Fallback reason codes (`app/core/constants.py`): `LOW_CLASSIFICATION_CONFIDENCE`,
`NO_RELEVANT_KNOWLEDGE`, `LOW_RETRIEVAL_CONFIDENCE`, `LLM_INSUFFICIENT_INFORMATION`.

Response shape returned to the server:

```jsonc
{
  "status": "success",
  "response": "…",
  "fallback_required": false,
  "reason": null,
  "intent":    { "predicted": "PRICING", "confidence": 0.93 },
  "retrieval": { "used_topic_filter": true, "top_score": 0.81, "documents_found": 3 },
  "debug":     { /* full trace — see §8.5 */ }
}
```

#### The second, newer pipeline: `/api/v1/ai/chat` (LangGraph)

[`agents/graph.py`](app/Ai/app/agents/graph.py) compiles a LangGraph `StateGraph` with two nodes:

```
START ─▶ retrieve ─▶ generate ─▶ END
```

- `retrieve_node` — pgvector search via `retrieval_service`, ML intent prediction, **and ML escalation
  prediction**; writes `retrieved_context`, `sources`, `retrieval_confidence`, `intent`, `should_escalate`
  into `AgentState`.
- `generate_node` — builds a grounded RAG prompt and calls the LLM.

This returns a *different* shape (`{ answer, intent, should_escalate, confidence, sources }`).
**The Node server does not call it.** It is reachable only via the AI service's own HTTP API / Swagger.

#### ML models

| Model | Type | Purpose |
| --- | --- | --- |
| Intent classifier | TF-IDF (5 000 features) + LogisticRegression, `max_iter=1000`, `C=1.0` | route the query to a topic |
| Escalation model | scikit-learn, feature-based | decide `should_escalate` from retrieval confidence, message length, conversation length, intent, sentiment, prior failed responses |

Both load from joblib artifacts and are cached as module-level singletons. If the intent artifact is
missing or unfitted, `predict_intent` falls back to a small keyword heuristic that returns
`confidence: 0.85` with `source: "heuristic_fallback"` — deliberately distinguishable from real ML output.

Training data (`app/ml/training/training_data.csv`) has **6 609 rows** across two incompatible label
vocabularies — see §8.4.

#### Providers

- **LLM** (`LLM_PROVIDER`): `openai` (default, `gpt-4o-mini`), `gemini` (`gemini-2.0-flash`), `grok`
  (`grok-3-mini`). Grok is reached through the OpenAI-compatible client with a different base URL. If no
  API key is configured, generation returns a **placeholder string** rather than failing — the service
  stays runnable with zero credentials.
- **Embeddings** (`EMBEDDING_PROVIDER`): `openai` (`text-embedding-3-small`, 1536 dims) or `huggingface`
  (`all-MiniLM`, 384 dims, runs locally, no key). Provider swaps change the vector width — see §8.7.

#### Vector store

`VectorStoreService` owns the `knowledge_chunks` table and creates it itself on startup
(`ensure_table()` runs `CREATE EXTENSION IF NOT EXISTS vector;` then `CREATE TABLE IF NOT EXISTS`), plus an
index on `bot_id`. Columns: `id, bot_id, content, embedding, topic, source_id, chunk_index, metadata`.

**Multi-tenancy here is a single `WHERE bot_id = $2` clause.** That is the entire isolation guarantee for
the vector store — there is no row-level security policy.

#### Knowledge ingestion

- `POST /api/v1/knowledge/ingest` — structured JSON entries `{ bot_id, entries: [{ id, topic, content }] }`
  → chunk → embed → store.
- `POST /api/v1/knowledge/ingest-document` — multipart PDF/DOCX → text extraction (pypdf / python-docx)
  → cleaner → chunker → same embed/store path. Returns `pages_extracted` and `chunks_created`.
- `DELETE /api/v1/knowledge/{bot_id}` — wipe all vectors for a bot.
- Chunking defaults: `CHUNK_SIZE=800`, `CHUNK_OVERLAP=100` (note the `RAGPipeline` class default is
  500/50 — the pipeline's own constructor arg differs from the settings value).

#### Observability endpoints (unauthenticated)

`/health`, `/api/v1/ai/status`, `/api/v1/ml/status`, `/api/v1/ml/evaluate`,
`/api/v1/testing/status`, `/api/v1/testing/vector-store/stats`, and the very useful
`POST /api/v1/testing/chat-pipeline` which returns the full debug trace (raw inputs, chunks, strategy,
prompts, raw LLM response). Swagger UI at `/docs` and ReDoc at `/redoc` are **enabled only when
`APP_ENV == "development"`**.

### 3.3 `app/client` — the frontend

**Stack:** Next.js **16.3.2** (App Router), React **19.2.8**, TailwindCSS **v4**, lucide-react,
react-markdown + remark-gfm. No state-management library.

> ⚠️ [`AGENTS.md`](app/client/AGENTS.md) carries a Next.js-generated warning: **this is not the Next.js in
> your training data** — APIs, conventions and file structure may differ. It instructs you to read the
> relevant guide in `node_modules/next/dist/docs/` before writing code, and notes that `next dev`
> re-creates this block on every run (so don't remove it from a diff; commit it with your work).
> [`CLAUDE.md`](app/client/CLAUDE.md) is a single line: `@AGENTS.md`.

**Structure:**

```
app/
├── page.tsx                    landing
├── login/, register/           auth pages
└── dashboard/
    ├── layout.tsx              authenticated shell
    ├── page.tsx                overview
    ├── workspaces/             list + [workspaceId] detail (bots under it)
    ├── bots/[botId]/           detail, knowledge/, conversations/
    └── ai-lab/                 AI operations console
components/
├── app-shell.tsx, sidebar.tsx, auth-guard.tsx
└── ui/  badge button card dialog empty-state input spinner tabs textarea toast
lib/
├── api-client.ts               fetch wrapper (single choke point)
├── auth-context.tsx            AuthProvider + useAuth
└── api/  auth bots conversations knowledge workspaces ai
```

**Auth handling:** the JWT lives in `localStorage` under `assistiq_token`. `AuthProvider` reads it on
mount, calls `GET /users/me` to hydrate the user, and clears the token on failure. `api-client.ts` attaches
`Authorization: Bearer <token>` to every request and, on **401**, clears the token and hard-redirects to
`/login`. `auth-guard.tsx` protects dashboard routes.

**`api-client.ts` is the single network choke point.** Everything goes through `apiRequest`, which
unwraps the server's `{ success, message, data }` envelope and throws a typed `ApiError` otherwise.
There are `apiGet/apiPost/apiPatch/apiDelete` helpers plus `apiPostFormData` for multipart uploads (it
deliberately omits `Content-Type` so the browser generates the multipart boundary).

---

## 4. The Core Security Rule — Tenant Isolation

This is the single most important design decision in the codebase.

Ownership is enforced **inside a single Prisma query whose `where` clause embeds the ownership join**. The
database does the isolation in one round-trip, and a cross-tenant id comes back as `null` → **404, never
403** — so the API does not even leak whether the resource exists.

```ts
// workspace:    scoped directly to the caller
prisma.workspace.findFirst({ where: { id, ownerId } })

// bot:          bot -> workspace -> ownerId
prisma.bot.findFirst({ where: { id: botId, workspace: { ownerId } } })

// knowledge:    knowledge -> bot -> workspace -> ownerId
prisma.knowledgeEntry.findFirst({ where: { id, bot: { workspace: { ownerId } } } })

// conversation: conversation -> bot -> workspace -> ownerId
prisma.conversation.findFirst({ where: { id, bot: { workspace: { ownerId } } } })
```

Two invariants make this work:

1. **`ownerId` always comes from the verified JWT**, never from the request body or params. Client-supplied
   ids are never trusted.
2. **Creating a child asserts ownership of the parent first**, then inserts. `createBot` calls
   `getWorkspaceById(workspaceId, ownerId)` before creating; `createKnowledge` and `createConversation`
   call `getBotById(botId, ownerId)` first.

The AI service mirrors this with its own `WHERE bot_id = ?` filter on every vector query.

---

## 5. End-to-End Flows

### 5.1 Adding a knowledge entry (the most interesting flow)

This is where all three services cooperate:

```
client  POST /api/v1/bots/:botId/knowledge  { title?, category?, question, answer }
   │
server  knowledge.service.createKnowledge()
   │  ├─ getBotById(botId, ownerId)                    ← ownership gate, 404 if not owned
   │  ├─ if no category:
   │  │     aiServiceClient.classifyIntent(text)       ─▶ Python POST /api/v1/ml/classify
   │  │     category = classification.intent           ← auto-categorise via the ML model
   │  ├─ prisma.knowledgeEntry.create({...})           ← Postgres is now the source of truth
   │  └─ aiServiceClient.ingestKnowledge({ bot_id, entries: [{ id, topic: category, content: "Q: …\nA: …" }] })
   │                                                   ─▶ Python POST /api/v1/knowledge/ingest
   │                                                        └─ chunk → embed → pgvector
   └─ 201 KnowledgeEntry
```

**The failure semantics matter:** the Postgres insert is **not rolled back** if the Python ingestion fails.
The server logs the error and still returns the entry. The rationale is that the FAQ is the durable record
and the vectors are a derived index — but it means a bot can silently have knowledge in the database that
the AI cannot retrieve. See §8.8.

### 5.2 A chat turn

```
client  POST /api/v1/conversations/:id/messages { content }
   │
server  conversation.service.addMessage()
   │  ├─ conversation.findFirst({ id, bot: { workspace: { ownerId } } })   ← 404 if not owned
   │  ├─ INSERT Message(role=USER)
   │  ├─ POST Python /api/v1/chat { bot_id, message }                      ← no auth header
   │  ├─ if fallback_required → UPDATE Conversation.status = WAITING_FOR_HUMAN
   │  ├─ INSERT Message(role=ASSISTANT, content=ai.response)
   │  └─ 201 { userMessage, assistantMessage, ai }
```

The AI metadata (`intent`, `retrieval`, `fallback_required`, `reason`) is passed through to the client, so
the UI can show *why* an answer was given — and the `ai-lab` page exists precisely to inspect this.

### 5.3 Document upload (not in most of the docs, but fully built)

```
client  POST /api/v1/bots/:botId/knowledge/upload-document   (multipart)
   │
server  multer (memoryStorage, 10 MB cap, PDF/DOCX mimetypes only)
   │  ├─ listKnowledgeByBot(botId, ownerId)      ← ownership gate
   │  ├─ rebuild a FormData from the buffer, append bot_id + optional topic
   │  └─ aiServiceClient.ingestDocument(formData) ─▶ Python POST /api/v1/knowledge/ingest-document
   │                                                  └─ extract → clean → chunk → embed → store
   └─ 201 { filename, pages_extracted, chunks_created }
```

Note the server does **not** create a `KnowledgeEntry` row for an uploaded document — the extracted text
lives only as vectors in `knowledge_chunks`. Uploaded-document knowledge therefore appears in chat answers
but **not** in the knowledge management UI.

---

## 6. Configuration

### Server (`app/server/.env`)

Zod-validated in [`env.ts`](app/server/src/config/env.ts); the process **exits with a clear message** if
anything is invalid.

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production` |
| `PORT` | no | `5000` | |
| `DATABASE_URL` | **yes** | — | must include `?schema=public` |
| `JWT_SECRET` | **yes** | — | min 16 chars, enforced |
| `JWT_EXPIRES_IN` | no | `7d` | |
| `AI_SERVICE_MODE` | no | `mock` | **parsed but never read** — see §8.1 |
| `AI_SERVICE_URL` | no | — | base URL of the Python service, e.g. `http://localhost:8000` |
| `AI_SERVICE_API_KEY` | no | — | **parsed but never used** |
| `CORS_ORIGIN` | no | `*` | `*` or comma-separated allowlist |
| `LOG_LEVEL` | no | `info` | pino level |

### AI service (`app/Ai/.env`)

Pydantic-settings, `extra="ignore"`, case-sensitive, loaded from `.env`.

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_ENV` | `development` | Swagger/ReDoc only served in `development` |
| `APP_PORT` | `8000` | |
| `LLM_PROVIDER` | `openai` | `openai` \| `gemini` \| `grok` |
| `LLM_MODEL` / `LLM_API_KEY` | `gpt-4o-mini` / `""` | empty key → placeholder responses |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | `""` / `gemini-2.0-flash` | |
| `GROK_API_KEY` / `GROK_MODEL` | `""` / `grok-3-mini` | |
| `EMBEDDING_PROVIDER` | `openai` | `openai` (1536d) \| `huggingface` (384d, local) |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/assistiq` | **see §8.3** |
| `VECTOR_STORE_TABLE` | `knowledge_chunks` | |
| `CLASSIFICATION_CONFIDENCE_THRESHOLD` | `0.60` | |
| `RETRIEVAL_CONFIDENCE_THRESHOLD` | `0.20` in code / `0.65` in `.env.example` | **see §8.2** |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `800` / `100` | |
| `REDIS_URL` | `redis://localhost:6379/0` | **defined but entirely unused** |
| `EXPRESS_BACKEND_URL` / `INTERNAL_API_KEY` | | **defined but entirely unused** |

### Client (`app/client/.env.local`)

`NEXT_PUBLIC_API_URL` (defaults to `http://localhost:5000/api/v1` if unset).

### Running the stack

```bash
# 1. database
cd app/server && docker compose up -d          # postgres:16-alpine, assistiq_db, port 5432

# 2. AI service  (order matters only in that models must be trained first)
cd app/Ai
python -m venv .venv && .venv\Scripts\activate      # Windows
pip install -r requirements.txt
cp .env.example .env                                # then fill in keys, or use gemini + huggingface for free
python -m app.ml.training.train                     # REQUIRED before first start — writes models/*.joblib
uvicorn app.main:app --reload --port 8000

# 3. server
cd app/server
npm install
cp .env.example .env                                # set DATABASE_URL + JWT_SECRET + AI_SERVICE_URL
npm run prisma:generate && npm run prisma:migrate
npm run dev                                          # port 5000

# 4. client
cd app/client
npm install && npm run dev                           # port 3000
```

There is a `Dockerfile` for the AI service only (python:3.12-slim, non-root `appuser`, copies
`app/ models/ data/`). Neither the server nor the client has a Dockerfile.

---

## 7. Testing & Verification

| Component | Command | Approach |
| --- | --- | --- |
| server | `npm test` (from `app/server`) | Vitest + Supertest; Prisma and `aiServiceClient` are `vi.mock`ed → **no DB, no Python needed** |
| Ai | `pytest` (from `app/Ai`) | `tests/test_health.py`, `tests/test_ai.py` |
| client | — | **no test setup at all**; `npm run lint` is the only check |

The server test suite is the most trustworthy artifact in the repo for understanding intended behaviour,
because it encodes the tenant-isolation guarantees as executable assertions.

Handy manual checks:

```bash
curl http://localhost:5000/health     # {"success":true,"status":"healthy","service":"assistiq-backend"}
curl http://localhost:8000/health
# Swagger: http://localhost:8000/docs
```

---

## 8. Doc-vs-Code Drift — Read This Before Trusting the Docs

Every item below was verified against source. The markdown in this repo describes an **earlier state** of
the project than the code is actually in.

### 8.1 The server has no mock AI mode — the docs' central claim is obsolete

`app/server/README.md` states the AI is a *"self-contained mock"*, that `ai.service.ts` exposes
`generateResponse()`, that `AI_SERVICE_MODE=mock` runs fully offline via keyword-overlap matching, and that
`live` mode calls `/api/v1/generate`.

**Reality:** the file is `aiServiceClient.ts`; there is **no mock implementation and no keyword matching
anywhere**. `chat()` always issues a real HTTP POST to `/api/v1/chat`. `AI_SERVICE_MODE` is still declared
in the Zod schema and documented in `.env.example`, but **grep confirms nothing reads it** — it is dead
config. Likewise `AI_SERVICE_API_KEY` is parsed but never sent, and the README's `/api/v1/generate`
endpoint **does not exist**.

*Consequence:* the backend cannot run without the Python service being reachable, despite the docs and
`.env.example` both saying it can.

### 8.2 `RETRIEVAL_CONFIDENCE_THRESHOLD` disagrees between code and config

`app/Ai/app/core/config.py` defaults it to `0.20`; `app/Ai/.env.example` sets `0.65`. Since `.env.example`
is copied to `.env`, the effective value is `0.65` — but the code default says `0.20`, so whichever wins
depends on whether a `.env` file exists. This threshold decides when retrieval is "confident", and the
`is_confident` flag is computed and returned but **never actually gates a fallback** in `chat_service.py`
(only *zero results* triggers `NO_RELEVANT_KNOWLEDGE`). So a weak-but-nonzero match proceeds to the LLM.
The `LOW_RETRIEVAL_CONFIDENCE` reason code is defined but never emitted.

### 8.3 The two services may point at different databases

`app/server` defaults to `assistiq_db`; `app/Ai/.env.example` defaults to `assistiq`. The AI README calls
the database *"owned by Express backend"*, and the design requires both to share one Postgres
(the relational tables *and* `knowledge_chunks`). If you copy each `.env.example` as-is, **the AI service
will build its own separate `knowledge_chunks` table in a different database** and retrieval will silently
return nothing. Both `DATABASE_URL`s must be made identical, with `CREATE EXTENSION vector;` available.

### 8.4 The trained intent model does not speak the vocabulary the code expects

`app/core/constants.py` defines 7 canonical intents (`ACCOUNT`, `BILLING`, `PRICING`, `REFUND`,
`SUBSCRIPTION`, `TECHNICAL_SUPPORT`, `GENERAL_SUPPORT`). But `training_data.csv` (6 609 rows) is dominated
by **27 labels from an e-commerce support dataset** (`cancel_order`, `track_order`, `get_refund`,
`recover_password`, `complaint`, …) with only **10 rows each** for the 7 canonical intents.

So the shipped model predominately predicts labels like `track_order`, which:
- are absent from `VALID_INTENTS`, and
- will never equal a knowledge entry's `category` in the common case… except that the server *auto-derives*
  `category` by calling the same classifier (§5.1). The two halves therefore agree with each other by
  accident, while both drift from the declared taxonomy, and `INTENT_GENERAL_SUPPORT` — the one value the
  routing logic special-cases — is a 10-row class the model will rarely output.

This also means topic-filtered retrieval is likely to be *narrower* than intended, and the
`VALID_INTENTS` list is effectively documentation of an aspiration, not the model's contract.

### 8.5 The chat response leaks a full debug trace

`chat_service._build_response()` attaches its entire `debug_info` block to **every** `/api/v1/chat`
response — including the raw system prompt, the full rendered user prompt, raw retrieved chunks, and the
raw LLM response. The Node `ChatResponse` interface doesn't declare `debug`, so the server ignores it, but
it travels over the wire and is serialised into the HTTP response. Prompt internals and retrieved tenant
content are therefore exposed to anything that can reach the AI service.

### 8.6 The AI service is completely unauthenticated

`INTERNAL_API_KEY` exists in settings and `.env.example`, but **no route has an auth dependency** — no
`x-api-key` check anywhere. The Node client's comment even says *"If there is an API key mechanism in the
future, add it here."* Every AI endpoint, including `/api/v1/chat`, `/api/v1/knowledge/ingest`,
`/api/v1/testing/*` and the destructive `DELETE /api/v1/knowledge/{bot_id}`, is open to anyone who can
reach port 8000. The AI's multi-tenancy is therefore *only* as strong as network isolation — and the
tenant key (`bot_id`) is a client-supplied string. `/api/v1/testing/chat-pipeline` also lets any caller
query any bot's knowledge.

### 8.7 Switching embedding providers silently invalidates the vector table

`VectorStoreService` reads a dimension from settings and creates `knowledge_chunks` with that fixed width.
Switching `EMBEDDING_PROVIDER` from `openai` (1536) to `huggingface` (384) — or back — makes existing rows
incompatible, and the code has no migration or guard for this. Because `ensure_table()` uses
`CREATE TABLE IF NOT EXISTS`, the stale table is **kept as-is** and inserts/searches will fail or return
garbage. Changing providers requires dropping and re-ingesting the table.

### 8.8 Knowledge ingestion failure is silent and non-atomic

In `knowledge.service.createKnowledge`, if the Python ingestion call throws, the error is logged and
swallowed — the DB row survives and the API returns 201. The bot then has FAQ entries that the AI cannot
retrieve. The same pattern applies to `deleteAllKnowledge` and `deleteBot` (vector cleanup failures are
logged and ignored). There is no reconciliation job or "unindexed" flag, so drift is invisible from the UI.

### 8.9 `currentImplementation.md` badly understates the client

That document calls the frontend *"🚧 Incomplete"* with scaffolding that *"lacks deep integration"*, no
chat UI, no knowledge UI, no document upload. The code disagrees substantially:

| Documented as missing | Actually present |
| --- | --- |
| API integration | Every page fetches real data through `lib/api/*` |
| Chat interface | `bots/[botId]/conversations/page.tsx` (337 lines) — message list, composer, markdown rendering via react-markdown + remark-gfm, escalation-aware placeholder |
| Knowledge UI | `bots/[botId]/knowledge/page.tsx` (622 lines) — full CRUD, modal forms, delete-all |
| Document upload | Wired end-to-end: UI → `apiPostFormData` → multer → AI `ingest-document` |
| AI operations UI | `dashboard/ai-lab/page.tsx` (500 lines) — classify, RAG search, pipeline debug, ML metrics, vector stats, system status |

Genuinely still missing on the client: any document-upload UI feedback for the *vector-only* entries
(§5.3), and — importantly — the docs' claim of *no state management* is still accurate: there's no React
Query/SWR, just `useEffect` + local state, so there is no cache invalidation strategy.

### 8.10 Smaller inconsistencies

- `app/Ai/README.md` says document parsing (PDF/text/URL) is *"not yet implemented"* — PDF and DOCX **are**
  implemented (`rag/ingestion/loaders.py`, `/knowledge/ingest-document`). URLs still are not.
- `app/Ai/README.md` presents the deterministic pipeline as *the* pipeline and never mentions LangGraph or
  the `/api/v1/ai/chat` endpoint, which `enpoints.md` does list.
- `app/server/endpoints.md` omits `POST /bots/:botId/knowledge/upload-document` entirely, though it is the
  route the client actually uses for uploads.
- `RAGPipeline`'s constructor defaults chunking to **500/50** while settings say **800/100** — two
  different chunk sizes coexist depending on which path builds the chunker.
- `REDIS_URL`, `EXPRESS_BACKEND_URL` and `INTERNAL_API_KEY` are configured but unused; `redis` is not even
  in `requirements.txt`.
- `enpoints.md` (both copies) has a typo in the filename.
- `app/client/README.md` is the untouched `create-next-app` boilerplate and describes a project that has
  nothing to do with AssistIQ.

---

## 9. What Is Actually Built vs Deferred

### Working end-to-end

- Registration, login, JWT-protected routes, stateless logout.
- Workspace / Bot / Knowledge CRUD with strict tenant isolation, verified by tests.
- Conversations and messages, with AI metadata surfaced to the UI.
- The deterministic classify → route → retrieve → validate → generate → fallback pipeline.
- PDF/DOCX ingestion into pgvector.
- Full client UI for auth, workspaces, bots, knowledge (including upload), conversations (with markdown
  chat), and an AI-lab operations console.
- Admin AI proxy surface on the server (8 endpoints under `/admin/ai/*`).
- A configurable LLM/embedding provider layer with a credential-free placeholder mode.

### Explicitly deferred (Review 2 roadmap, partly still accurate)

- **Roles & team members** — no membership table, no invitations, no RBAC. `constants/roles.ts` is the
  designated seam. Today: strictly single-owner.
- **Human handoff** — `shouldEscalate` / `WAITING_FOR_HUMAN` are computed and stored, but **nothing routes
  the conversation to an actual agent**. The status is set and then sits there. The client even renders
  *"Waiting for human agent to reply…"* on a channel no agent can answer.
- **Server-side logout** — no blacklist, no refresh rotation.
- **Per-entry knowledge delete** — deliberately returns **501** with a "delete all instead" message
  (`knowledge.service.deleteKnowledge`). The client still exposes the single-delete call, so that path
  surfaces a 501 to the user.
- **Pagination, metrics, per-tenant rate limits** — none. Auth routes are rate-limited per IP only.
- **Vector-store reconciliation** — no way to detect or repair Postgres/vector drift (§8.8).

### Gaps worth naming that no doc mentions

- **No streaming.** Every chat response is a blocking round-trip through two services. `askMessage` waits
  for the full LLM completion.
- **No conversation memory.** `addMessage` sends only the current message; prior turns are stored in
  Postgres but never sent to the AI. The escalation model even accepts a `conversation_length` parameter
  that the caller never supplies (it always defaults to `1`).
- **`assignedAgentId` is write-never.** The column exists on `Conversation` and is returned by the API,
  but no code path ever sets it.
- **No refresh of `updatedAt`-driven UI**, no optimistic updates, no loading skeletons on several pages.
- **`window.location.href` redirect on 401** in `api-client.ts` is a full page reload rather than a router
  navigation.

---

## 10. Mental Model — The Short Version

If you remember five things about this codebase:

1. **Three services, one direction.** Browser → `server` → `Ai`. The AI service is never called by the
   browser, and it trusts whatever `bot_id` it is handed.
2. **Tenancy is a `where` clause.** Isolation lives in Prisma queries that walk
   `resource → bot → workspace → ownerId`, with `ownerId` from the JWT. Cross-tenant reads return **404,
   never 403**. The vector store's equivalent is `WHERE bot_id = $1`.
3. **The AI refuses to guess.** Classifier → pgvector → temperature-0 LLM grounded on retrieved chunks,
   with `INSUFFICIENT_INFORMATION` as a first-class outcome that flips a conversation to
   `WAITING_FOR_HUMAN`.
4. **Postgres is the source of truth; vectors are a derived index.** The ingest path writes to Prisma
   first, then to pgvector, and does not roll back on AI failure. Drift is possible and undetectable.
5. **The docs are behind the code.** `app/currentImplementation.md` and `app/server/README.md` describe a
   mock-AI, incomplete-frontend version of the project that no longer exists. Treat §8 as the errata
   sheet, and treat the server's Vitest suite as the most reliable description of intended behaviour.

---

## 11. Suggested Next Steps

Ordered by what unblocks the most, not by size:

1. **Fix the `DATABASE_URL` mismatch (§8.3)** — without this, nothing works end-to-end on a fresh clone.
   Make both `.env.example` files point at the same Postgres with `vector` available.
2. **Add auth to the AI service (§8.6)** — a single `x-api-key` dependency against `INTERNAL_API_KEY`,
   sent by `aiServiceClient`. It's a small change that closes the largest hole.
3. **Strip the `debug` block from `/api/v1/chat` (§8.5)** — keep it behind the existing
   `/api/v1/testing/chat-pipeline` endpoint, which already exists for exactly that purpose.
4. **Reconcile the intent taxonomy (§8.4)** — either retrain on the 7 canonical intents, or delete
   `VALID_INTENTS` and adopt the e-commerce label set as the real contract. Right now the routing logic
   and the model disagree about the world.
5. **Make ingestion failures visible (§8.8)** — a `vectorSyncedAt`/`indexed` flag on `KnowledgeEntry`, or
   a small reconcile endpoint. Silent drift is the kind of bug that surfaces as "the bot is dumb" weeks
   later.
6. **Decide the fate of the two pipelines** — pick `/api/v1/chat` or the LangGraph `/api/v1/ai/chat` and
   retire the other, or wire the LangGraph graph into `chat_service` so escalation actually uses the ML
   escalation model that's already trained and loaded.
7. **Delete the dead config (§8.1)** — `AI_SERVICE_MODE` / `AI_SERVICE_API_KEY` on the server,
   `REDIS_URL` / `EXPRESS_BACKEND_URL` / `INTERNAL_API_KEY` on the AI side. Leaving them makes `.env.example`
   lie about how the system starts.
8. **Then** the roadmap items: human handoff (the status half is already built), roles/membership, and
   conversation memory in the chat prompt.
