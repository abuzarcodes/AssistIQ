# AssistIQ — Backend (Review 1)

The Node.js/TypeScript backend for **AssistIQ**, a multi-tenant, AI-powered customer-support
SaaS. This Review 1 foundation implements the full request flow —
**Auth → Workspace → Bot → Knowledge → Conversation → AI-service boundary** — with strict
tenant isolation, and is structured so the future Python AI/ML service drops in via
configuration with no core changes.

> **Scope (Review 1).** This is the backend only. There is **no** frontend, **no** Python/ML
> service, and **no** RAG/embeddings/LangChain here. The AI is a self-contained *mock* that
> demonstrates the request/response contract. See [Review 2 roadmap](#review-2-roadmap).

---

## Tech stack

| Concern            | Choice                                             |
| ------------------ | -------------------------------------------------- |
| Runtime            | Node.js 20+ (uses global `fetch`)                  |
| Language           | TypeScript (strict), ESM + NodeNext                |
| Web framework      | Express 4                                          |
| Database           | PostgreSQL 16                                      |
| ORM                | Prisma 6                                           |
| Auth               | JWT (`jsonwebtoken`), stateless bearer tokens      |
| Password hashing   | `bcryptjs` (12 salt rounds)                        |
| Validation         | Zod (every external input)                         |
| Logging            | `pino` / `pino-http` (structured, redacted)        |
| Security           | `helmet`, `cors`, `express-rate-limit`             |
| Tests              | Vitest + Supertest (DB & AI mocked)                |

---

## Project structure

```
app/server/
├── prisma/
│   └── schema.prisma          # User, Workspace, Bot, KnowledgeEntry, Conversation, Message + MessageRole
├── src/
│   ├── config/
│   │   ├── env.ts             # Zod-validated environment, fail-fast at startup
│   │   ├── database.ts        # PrismaClient singleton
│   │   └── logger.ts          # pino logger (redacts secrets/tokens/passwords)
│   ├── constants/
│   │   └── roles.ts           # MessageRole re-export + placeholder for future user roles
│   ├── types/
│   │   ├── common.types.ts    # AuthUser, JwtPayload, AIRequestInput, AIResponse
│   │   └── express.d.ts        # declaration-merges req.user (no `any`)
│   ├── utils/
│   │   ├── errors.ts          # AppError + typed subclasses (400/401/403/404/409)
│   │   ├── apiResponse.ts     # sendSuccess() — consistent envelope
│   │   ├── asyncHandler.ts    # forwards async errors to the error handler
│   │   ├── jwt.ts             # signToken / verifyToken
│   │   └── password.ts        # hashPassword / comparePassword
│   ├── middleware/
│   │   ├── auth.middleware.ts # Bearer JWT → req.user; getAuthUser() narrowing helper
│   │   ├── validation.middleware.ts  # validate({ body?, params?, query? })
│   │   ├── errorHandler.ts    # centralized; maps AppError/Zod/Prisma → status + envelope
│   │   └── notFoundHandler.ts
│   ├── schemas/               # Zod schemas per resource (bodies + :id params)
│   ├── services/              # business logic + DB access + ownership checks
│   │   ├── auth.service.ts    │   ├── workspace.service.ts
│   │   ├── user.service.ts    │   ├── bot.service.ts
│   │   ├── knowledge.service.ts   ├── conversation.service.ts  # chat orchestration
│   │   └── ai.service.ts      # the ONLY place that talks to the AI service
│   ├── controllers/           # thin: read input, call a service, send the response
│   ├── routes/                # endpoints + middleware wiring only (/api/v1 tree)
│   ├── app.ts                 # express app: security, /health, /api/v1, error handling
│   └── server.ts              # entrypoint: DB connect, listen, graceful shutdown
├── tests/                     # Vitest suites (auth, workspace, bot, conversation)
├── docker-compose.yml         # local PostgreSQL 16
├── .env.example
└── package.json
```

**Layering rule.** `routes → controllers → services → prisma`. Controllers never touch the
database or contain business logic; services own all business logic, DB access, and
**ownership checks**; the AI service is reached **only** through `ai.service.ts`.

---

## Prerequisites

- **Node.js 20+** and npm
- **PostgreSQL 16** — either via the bundled `docker-compose.yml`, or an existing local server

---

## Setup

All commands run from `app/server/`.

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Then edit `.env` (see [Environment variables](#environment-variables)). At minimum set a real
`DATABASE_URL` and a `JWT_SECRET` of at least 16 characters.

### 3. Start PostgreSQL

**Option A — Docker (recommended).** Provisions a `postgres` / `password` role and an
`assistiq_db` database that match the sample `DATABASE_URL`:

```bash
docker compose up -d
```

**Option B — existing PostgreSQL.** Create the database and point `DATABASE_URL` at it with
**your** credentials:

```sql
CREATE DATABASE assistiq_db;
```

```
DATABASE_URL="postgresql://<user>:<password>@localhost:5432/assistiq_db?schema=public"
```

### 4. Generate the Prisma client & run migrations

```bash
npm run prisma:generate   # generates the typed client
npm run prisma:migrate    # creates/applies the initial migration (needs a reachable DB)
```

> If `prisma migrate` reports **P1000 (authentication failed)**, the server is reachable but
> the credentials in `DATABASE_URL` are wrong — fix them (or use `docker compose up -d`, which
> creates a role matching the sample values).

### 5. Run

```bash
npm run dev     # tsx watch, hot reload
# or
npm run build && npm start
```

Verify:

```bash
curl http://localhost:5000/health
# { "success": true, "status": "healthy", "service": "assistiq-backend" }
```

---

## Environment variables

Validated by Zod at startup ([`src/config/env.ts`](src/config/env.ts)); the process **exits**
with a clear message if any are invalid.

| Variable             | Required | Default       | Notes                                                     |
| -------------------- | -------- | ------------- | --------------------------------------------------------- |
| `NODE_ENV`           | no       | `development` | `development` \| `test` \| `production`                   |
| `PORT`               | no       | `5000`        |                                                           |
| `DATABASE_URL`       | **yes**  | —             | PostgreSQL connection string                              |
| `JWT_SECRET`         | **yes**  | —             | ≥ 16 chars; use a strong random value in production       |
| `JWT_EXPIRES_IN`     | no       | `7d`          | e.g. `1h`, `7d`                                           |
| `AI_SERVICE_MODE`    | no       | `mock`        | `mock` (Review 1) \| `live` (future Python service)       |
| `AI_SERVICE_URL`     | no       | —             | Base URL of the Python service (used when `live`)         |
| `AI_SERVICE_API_KEY` | no       | —             | Sent as `x-api-key` to the Python service (when `live`)   |
| `CORS_ORIGIN`        | no       | `*`           | `*`, or a comma-separated allowlist                       |
| `LOG_LEVEL`          | no       | `info`        | pino level (`silent` in tests)                            |

---

## API reference

Base path: **`/api/v1`**. All responses use a consistent envelope:

```jsonc
// success
{ "success": true,  "message": "…", "data": { … } }
// error
{ "success": false, "message": "…" }
```

`GET /health` is public and lives **outside** `/api/v1`.

Auth column: 🔓 public · 🔒 requires `Authorization: Bearer <token>`.

### Auth

| Method | Path                  | Auth | Body                          | Success |
| ------ | --------------------- | ---- | ----------------------------- | ------- |
| POST   | `/auth/register`      | 🔓   | `{ name, email, password≥8 }` | 201 → `{ user, token }` |
| POST   | `/auth/login`         | 🔓   | `{ email, password }`         | 200 → `{ user, token }` |
| POST   | `/auth/logout`        | 🔓   | —                             | 200 (client discards token) |

> `/auth/register` and `/auth/login` are rate-limited to **20 requests / 15 minutes** per IP.

### Users

| Method | Path         | Auth | Success |
| ------ | ------------ | ---- | ------- |
| GET    | `/users/me`  | 🔒   | 200 → current user (no password hash) |

### Workspaces

| Method | Path                  | Auth | Body           | Success |
| ------ | --------------------- | ---- | -------------- | ------- |
| POST   | `/workspaces`         | 🔒   | `{ name }`     | 201 |
| GET    | `/workspaces`         | 🔒   | —              | 200 → caller's workspaces |
| GET    | `/workspaces/:workspaceId` | 🔒 | —          | 200 (404 if not owned) |

### Bots (nested under a workspace for create/list)

| Method | Path                                   | Auth | Body                        | Success |
| ------ | -------------------------------------- | ---- | --------------------------- | ------- |
| POST   | `/workspaces/:workspaceId/bots`        | 🔒   | `{ name, description? }`    | 201 |
| GET    | `/workspaces/:workspaceId/bots`        | 🔒   | —                           | 200 |
| GET    | `/bots/:botId`                         | 🔒   | —                           | 200 (404 if not owned) |
| PATCH  | `/bots/:botId`                         | 🔒   | `{ name?, description? }`   | 200 |
| DELETE | `/bots/:botId`                         | 🔒   | —                           | 200 (cascades knowledge/conversations) |

### Knowledge base (FAQ, nested under a bot for create/list)

| Method | Path                              | Auth | Body                                          | Success |
| ------ | --------------------------------- | ---- | --------------------------------------------- | ------- |
| POST   | `/bots/:botId/knowledge`          | 🔒   | `{ title?, category?, question, answer }`     | 201 |
| GET    | `/bots/:botId/knowledge`          | 🔒   | —                                             | 200 |
| PATCH  | `/knowledge/:knowledgeId`         | 🔒   | any subset of the create fields               | 200 |
| DELETE | `/knowledge/:knowledgeId`         | 🔒   | —                                             | 200 |

### Conversations & messages

| Method | Path                                        | Auth | Body            | Success |
| ------ | ------------------------------------------- | ---- | --------------- | ------- |
| POST   | `/bots/:botId/conversations`                | 🔒   | —               | 201 |
| GET    | `/bots/:botId/conversations`                | 🔒   | —               | 200 |
| GET    | `/conversations/:conversationId`            | 🔒   | —               | 200 → conversation **with messages** |
| POST   | `/conversations/:conversationId/messages`   | 🔒   | `{ content }`   | 201 → `{ userMessage, assistantMessage, ai }` |

---

## Authentication flow

1. **Register** or **login** → the server returns a signed **JWT** (`sub` = user id, `email`)
   and the user profile (never the password hash).
2. The client stores the token and sends it on every protected request:
   `Authorization: Bearer <token>`.
3. `auth.middleware` verifies the token, rejects invalid/expired/missing tokens with **401**,
   and attaches `req.user = { id, email }`.
4. **Logout** is client-side: the token is stateless, so the client discards it. (A
   server-side blacklist is deliberately deferred to Review 2 and documented honestly rather
   than faked.)

Passwords are hashed with `bcryptjs` (12 rounds). Login returns a single generic
`Invalid email or password` for both unknown-email and wrong-password cases, so the API never
reveals which emails exist.

---

## Multi-tenant ownership model (the core security rule)

A user must **never** be able to read or modify another user's resources. Every resource is
owned transitively:

```
User ──owns──▶ Workspace ──has──▶ Bot ──has──▶ KnowledgeEntry
                                    └─has──▶ Conversation ──has──▶ Message
```

Ownership is enforced **in the service layer**, in a **single query whose `where` embeds the
ownership join** — so the database itself enforces isolation in one round-trip, and a
cross-tenant id simply returns `null` → **404** (never a 403, so we don't even leak that the
resource exists):

```ts
// workspace:    scoped to the caller
prisma.workspace.findFirst({ where: { id, ownerId } })
// bot:          bot -> workspace -> ownerId
prisma.bot.findFirst({ where: { id: botId, workspace: { ownerId } } })
// knowledge:    knowledge -> bot -> workspace -> ownerId
prisma.knowledgeEntry.findFirst({ where: { id, bot: { workspace: { ownerId } } } })
// conversation: conversation -> bot -> workspace -> ownerId
prisma.conversation.findFirst({ where: { id, bot: { workspace: { ownerId } } } })
```

Creating a child resource **first asserts ownership of the parent** using the same pattern,
then inserts. The owner id always comes from the **verified token**, never from the request
body or params — client-supplied ids are never trusted. Deleting a bot cascades to its
knowledge, conversations, and messages via Prisma `onDelete: Cascade`.

Additional hardening: `helmet` headers, configurable CORS, JSON body size limit, auth-route
rate limiting, and a logger that **redacts** `Authorization`/`Cookie` headers and any
`password`/`passwordHash`/`token` fields. The centralized error handler maps known errors to
correct status codes and **never** returns stack traces, DB internals, or secrets in
production.

---

## AI service boundary

All AI communication is isolated in [`src/services/ai.service.ts`](src/services/ai.service.ts),
which exposes a single contract:

```ts
generateResponse(input: AIRequestInput): Promise<AIResponse>
// AIResponse = { answer: string; intent?: string; confidence?: number; shouldEscalate?: boolean }
```

- **`AI_SERVICE_MODE=mock`** (Review 1 default): a dependency-free keyword-overlap match
  against the bot's FAQ knowledge. **This is not ML** — it only exercises the request/response
  and escalation contract. The backend runs **fully offline**; no Python service is required.
- **`AI_SERVICE_MODE=live`** (future): `fetch(`${AI_SERVICE_URL}/api/v1/generate`)` with an
  `x-api-key` header and a 15s timeout. Failures are logged and surfaced as a graceful `502` —
  internal details are never leaked to the client.

The **conversation service** orchestrates the chat flow (`addMessage`): verify ownership →
store the `USER` message → gather the bot's knowledge → `generateResponse` → store the
`ASSISTANT` message → return both plus AI metadata. Controllers never call the AI service
directly. Swapping mock → live is a **config change, not a refactor**.

---

## Testing

```bash
npm test          # run once
npm run test:watch
```

Vitest + Supertest. Prisma and the AI service are **mocked** (`vi.mock`), so tests need
**no database and no Python service**. Tokens are minted with the real JWT util. Coverage:

- **auth** — register (201), duplicate email (409), invalid input (400), login (200),
  invalid login (401, generic message), protected route without token (401).
- **workspace** — create (owner from token, not body); cross-tenant read → 404.
- **bot** — create (asserts workspace ownership first); cannot create in another user's
  workspace (404); cross-tenant read → 404.
- **conversation** — create under an owned bot; `sendMessage` stores USER + ASSISTANT and calls
  the AI boundary once; cross-tenant post → 404 and the AI service is **never** called; empty
  message → 400.

---

## npm scripts

| Script                   | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| `npm run dev`            | Hot-reloading dev server (`tsx watch`)     |
| `npm run build`          | Type-check + compile to `dist/`            |
| `npm start`              | Run compiled server (`dist/server.js`)     |
| `npm test`               | Run Vitest suites once                     |
| `npm run test:watch`     | Vitest watch mode                          |
| `npm run prisma:generate`| Generate the Prisma client                 |
| `npm run prisma:migrate` | Create/apply migrations (`migrate dev`)    |
| `npm run prisma:studio`  | Open Prisma Studio                         |

---

## Review 2 roadmap

Intentionally **not** built in Review 1, and where the architecture already leaves room:

- **Real AI/ML service** — Python/FastAPI with RAG, embeddings, and a vector store; enabled by
  flipping `AI_SERVICE_MODE=live` (the boundary already exists).
- **Roles & team members** — workspace membership, invitations, and role-based authorization
  (the single-owner model and `constants/roles.ts` placeholder are the seam).
- **Human handoff** — act on the AI's `shouldEscalate` signal to route conversations to agents.
- **Document upload** — ingest PDFs/URLs into the knowledge base for RAG.
- **Server-side logout** — a token blacklist / refresh-token rotation to replace stateless
  client-side logout.
- **Ops** — pagination, richer observability/metrics, and per-tenant rate limiting.
