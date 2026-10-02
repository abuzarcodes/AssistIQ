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
│   │   └── roles.ts           # MessageRole re-export (single import site)
│   ├── types/
│   │   ├── common.types.ts    # AuthUser, JwtPayload
│   │   └── express.d.ts        # declaration-merges req.user (no `any`)
│   ├── utils/
│   │   ├── errors.ts          # AppError + typed subclasses (400/401/404/409)
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
npm run prisma:migrate    # creates/applies migrations (needs a reachable DB)
```

Two migrations make up the current schema:

| Migration                      | What it does                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `0_init`                       | The base schema (users, workspaces, bots, knowledge, conversations, messages).                        |
| `20261002141705_init_rbac`     | Adds the `PlatformRole` and `WorkspaceRole` enums, `users.platformRole`, and the `workspace_members` table. Additive only — no data is dropped. |

After migrating, confirm the RBAC data is consistent:

```bash
npm run verify:rbac   # every workspace has an OWNER membership matching workspace.ownerId
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
| `AI_SERVICE_URL`     | no       | —             | Base URL of the Python FastAPI service                    |
| `AI_SERVICE_TIMEOUT` | no       | `30000`       | Per-request timeout (ms); uploads use 3× this value       |
| `AI_SERVICE_API_KEY` | **yes**  | —             | Sent as `X-API-Key`; must equal the AI service's own value. There is no disabled mode — the AI service rejects requests without it |
| `PLATFORM_OWNER_EMAIL` | no     | —             | Account promoted to `PLATFORM_OWNER` by `npm run db:seed`  |
| `CORS_ORIGIN`        | no       | `*`           | `*`, or a comma-separated allowlist                       |
| `LOG_LEVEL`          | no       | `info`        | pino level (`silent` in tests)                            |

---

## API reference

Base path: **`/api/v1`**. All responses use a consistent envelope:

```jsonc
// success
{ "success": true,  "message": "…", "data": { … } }
// error
{ "success": false, "error": "…", "message": "…" }
```

> On errors `error` is the canonical field and `message` mirrors it for backwards
> compatibility with existing clients.

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
// workspace:    scoped to the caller's membership
prisma.workspace.findFirst({ where: { id, members: { some: { userId } } } })
// bot:          bot -> workspace -> membership
prisma.bot.findFirst({ where: { id: botId, workspace: { members: { some: { userId } } } } })
// knowledge:    knowledge -> bot -> workspace -> membership
prisma.knowledgeEntry.findFirst({ where: { id, bot: { workspace: { members: { some: { userId } } } } } })
// conversation: conversation -> bot -> workspace -> membership
prisma.conversation.findFirst({ where: { id, bot: { workspace: { members: { some: { userId } } } } } })
```

Membership (not `ownerId`) is the gate, so ADMIN and AGENT members are admitted alongside the
owner. `workspace.ownerId` is kept during the transition and `npm run verify:rbac` proves the
two stay in step; it is no longer what authorization reads. See **Authorization (RBAC)** below.

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

## Authorization (RBAC)

Authorization is layered **on top of** the ownership rule above, and never replaces it: the
service-layer scoping is what makes the isolation survive even if the middleware is removed.

### Two independent domains

| Domain        | Role lives on                  | Roles                       | Gates                                 |
| ------------- | ------------------------------ | --------------------------- | ------------------------------------- |
| **Platform**  | `User.platformRole`            | `USER`, `PLATFORM_OWNER`     | `/api/v1/platform/*`, `/api/v1/admin/ai/*` |
| **Workspace** | `WorkspaceMember.role`         | `OWNER`, `ADMIN`, `AGENT`    | everything scoped to a workspace      |

They are evaluated independently. A `PLATFORM_OWNER` who is only an `AGENT` in a workspace
stays an `AGENT` there, and a platform owner who is **not** a member of a workspace gets the
same `404` as anyone else — the platform role grants nothing inside the workspace domain.

### Permissions

Permissions are named `<resource>:<action>` and defined once in
[`src/constants/permissions.ts`](src/constants/permissions.ts), which also holds the
role → permission matrix. Routes reference `PERMISSIONS.*` and never an inline string, so the
matrix is the single source of truth.

| Role    | Can                                                                                  | Cannot                                        |
| ------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| `OWNER` | everything, including `members:manage` and workspace settings                          | —                                             |
| `ADMIN` | manage bots, knowledge and documents; reply/resolve/assign conversations                | manage members, update or delete the workspace |
| `AGENT` | read workspace/knowledge context, reply to and resolve conversations                   | view or manage bots, manage knowledge, manage members, assign conversations |

### Denial semantics (important)

- **No workspace membership → `404`**, never `403`. A tenant the caller cannot see must be
  indistinguishable from one that does not exist, so the pre-RBAC isolation guarantee holds.
- **Member whose role lacks the permission → `403`.**
- **Not authenticated → `401`**, checked before any authorization runs.

Enforcement lives in [`src/middleware/authorization.middleware.ts`](src/middleware/authorization.middleware.ts):
`requireWorkspacePermission(permission, scope)` and `requirePlatformOwner()`. Routes carrying no
workspace id declare how to resolve one — `{ from: 'bot' }`, `{ from: 'knowledge' }` or
`{ from: 'conversation' }`. The platform role is re-read from the database rather than trusted
from the JWT, so a promotion or demotion applies immediately to already-issued tokens.

### Platform owners

`PLATFORM_OWNER` is what unlocks the AI Lab (`/api/v1/admin/ai/*`) and platform administration
(`/api/v1/platform/*`); both are closed to ordinary users. To create one, register the account
first and then set `PLATFORM_OWNER_EMAIL` in the environment and run:

```bash
npm run db:seed   # backfills OWNER memberships and promotes PLATFORM_OWNER_EMAIL
```

The seed is idempotent and safe to re-run.

### Tests

[`tests/rbac-matrix.test.ts`](tests/rbac-matrix.test.ts) drives the real route table across
every role — including a non-member and a non-member platform owner — and asserts that a denied
request returns the right status **and writes nothing**. [`tests/rbac-compat.test.ts`](tests/rbac-compat.test.ts)
pins the service-layer scope predicates that the rollback story depends on.

---

## AI service boundary

All AI communication is isolated in [`src/services/aiServiceClient.ts`](src/services/aiServiceClient.ts),
a singleton that wraps `fetch` and is the **only** place the backend talks to Python:

- **Core:** `chat()` → `POST /api/v1/chat`, `ingestKnowledge()` → `POST /api/v1/knowledge/ingest`,
  `deleteBotKnowledge()` → `DELETE /api/v1/knowledge/{botId}`, `classifyIntent()` →
  `POST /api/v1/ml/classify`, `ingestDocument()` → `POST /api/v1/knowledge/ingest-document`.
- **Admin/testing (proxied under `/api/v1/admin/ai/*`):** `searchVectors`, `getAiStatus`,
  `getMlStatus`, `evaluateMlModel`, `getSystemStatus`, `getVectorStats`, `debugChatPipeline`.

Every request is bounded by `AbortSignal.timeout(AI_SERVICE_TIMEOUT)` (uploads use 3×).
Any transport failure or non-2xx response is mapped to a `502` with a generic message —
internal details are never leaked to the client. `AI_SERVICE_URL` must be configured or the
call fails fast with a `500`.

The **conversation service** orchestrates the chat flow (`addMessage`): verify ownership →
store the `USER` message → call `aiServiceClient.chat()` → flip the conversation to
`WAITING_FOR_HUMAN` when `fallback_required` → store the `ASSISTANT` message → return both
plus AI metadata. Controllers never call the AI service directly.

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

- **Human handoff** — act on the AI's `fallback_required` signal to route conversations to agents.
- **Document upload** — ingest PDFs/URLs into the knowledge base for RAG.
- **Server-side logout** — a token blacklist / refresh-token rotation to replace stateless
  client-side logout.
- **Ops** — pagination, richer observability/metrics, and per-tenant rate limiting.
