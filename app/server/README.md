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
│                              #   + AIProvider, AIModel, WorkspaceMember (RBAC), PlatformRole/WorkspaceRole
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
│   │   ├── aiCatalog.service.ts   # platform-owned AI model catalog
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

Three migrations make up the current schema:

| Migration                            | What it does                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `0_init`                             | The base schema (users, workspaces, bots, knowledge, conversations, messages).                        |
| `20261002141705_init_rbac`           | Adds the `PlatformRole` and `WorkspaceRole` enums, `users.platformRole`, and the `workspace_members` table. Additive only — no data is dropped. |
| `20261002181628_add_ai_model_catalog` | Adds `ai_providers` and `ai_models`, and a nullable `bots.aiModelId` referencing `ai_models` with `onDelete: Restrict`. Additive only — every existing bot is left with a `NULL` model, which is the current behaviour. |

> The catalog migration is **additive and non-destructive** by design: `aiModelId` is
> nullable, so no bot is forced onto a model, and `Restrict` (rather than `Cascade`) means
> deleting a catalog entry that a bot still points at fails loudly instead of silently
> unassigning tenants. The `ai_models` row is seeded with every provider
> **disabled** — the catalog changes nothing until a platform owner turns it on.

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
| PATCH  | `/bots/:botId/model`                   | 🔒   | `{ aiModelId: uuid \| null }` | 200 → bot with its model |
| DELETE | `/bots/:botId`                         | 🔒   | —                           | 200 (cascades knowledge/conversations) |

> `PATCH /bots/:botId/model` requires `bots:manage` (OWNER or ADMIN) — the same permission as
> renaming a bot, deliberately reused rather than a new one, because an AGENT must not gain
> model-selection rights. `aiModelId` is validated as an **internal catalog uuid**, so a
> provider-native id such as `openai/gpt-4o` is a **400** before any handler runs. Sending
> `null` clears the assignment and is always permitted. See [AI model catalog](#ai-model-catalog).

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

### AI model catalog

Two audiences, two surfaces. The **workspace-facing** route is how a client renders a model
selector; the **platform** routes are how a platform owner curates what that selector offers.

| Method | Path                            | Auth | Body / query | Success |
| ------ | ------------------------------- | ---- | ------------ | ------- |
| GET    | `/ai/models`                    | 🔒   | —            | 200 → enabled models of enabled providers |
| GET    | `/platform/providers`           | 🔒 + PLATFORM_OWNER | — | 200 → every provider, with counts and readiness |
| PATCH  | `/platform/providers/:providerId` | 🔒 + PLATFORM_OWNER | `{ name?, description?, enabled? }` | 200 |
| GET    | `/platform/models`              | 🔒 + PLATFORM_OWNER | `?providerId=<uuid>&enabled=true\|false` | 200 → every model, any state |
| POST   | `/platform/models`              | 🔒 + PLATFORM_OWNER | `{ providerId, providerModelId, displayName, enabled? }` | 201 |
| PATCH  | `/platform/models/:modelId`     | 🔒 + PLATFORM_OWNER | `{ displayName?, enabled? }` | 200 |
| DELETE | `/platform/models/:modelId`     | 🔒 + PLATFORM_OWNER | —            | 200 (409 while a bot references it) |

**Two projections, deliberately different.**

- `GET /ai/models` returns exactly `{ id, displayName, provider: { slug, name } }`.
  `providerModelId` — the provider-native id — is **absent**, and so is every enabled flag and
  bot count. A workspace selects by internal uuid; handing it the native id would invite a
  client to call the provider directly, which is the catalog bypass this API exists to prevent.
- `GET /platform/models` is the operator's view and *does* carry `providerModelId`, the
  resolved provider, and a live `botCount` (computed from the relation, never a stored counter
  that could drift).

**No credential ever crosses this boundary.** Neither surface returns an API key, and the
server holds no provider credential to return — see [Provider readiness](#provider-readiness).
The platform payload reports readiness as two nullable booleans, never as a masked string.

**Identity fields are write-once.** `providerModelId` (models) and `slug` (providers) are set
at creation and cannot be changed. `PATCH /platform/models` and `PATCH /platform/providers` are
`.strict()` schemas, so a body containing either field is rejected with a **400** rather than
having the field silently stripped — a `200` that ignored the field would mislead the client
about what the system will actually call. Correcting a wrong `providerModelId` is
delete-and-recreate, which is safe precisely because deletion is blocked while the model is in
use.

**New models are created disabled.** `enabled` defaults to `false`, so a `POST` cannot by
itself change what tenants can select. A model is selectable only when **both** the model and
its provider are enabled — two independent gates, both flipped deliberately.

---

## Provider readiness

`GET /platform/providers` reports, per provider, two **independent** nullable booleans plus
derived model counts:

| Field                  | Meaning                                                                 | `null` means |
| ---------------------- | ----------------------------------------------------------------------- | ------------ |
| `adapterAvailable`     | The AI service has a Python adapter registered for this provider slug     | the AI service could not be reached |
| `credentialConfigured` | That adapter reports its provider credential is present in **its** env    | same |
| `modelCount` / `enabledModelCount` | Derived live from the relation, never stored                 | — |

They are separate on purpose: a missing adapter is a **deployment** problem, a missing
credential is a **configuration** problem, and the operator's fix differs. Collapsing them into
one "health" dot would hide which one is wrong.

`null` is not `false`. When the AI service is unreachable, or does not report adapters at all,
the fields are `null` — rendered as "unknown" — because claiming `false` would assert "no
adapter is registered", which this code cannot know. This is what keeps the provider list
renderable while the AI service is down; readiness degrades, the list does not.

> **v1 measures no live reachability.** No dashboard request makes a provider-bound network
> call. A configured credential is reported as configured, not as *working* — a revoked key
> still reads `true` until the provider is actually called at chat time, where it surfaces as
> `MODEL_UNAVAILABLE`. This is a deliberate scope decision, not an oversight.

## Attribution of catalog changes

Every successful catalog mutation (create, enable/disable, edit, delete) writes **one**
structured log record — `action`, `actorId`, `targetId`, and the resulting state:

```jsonc
{ "level": 30, "actorId": "…", "action": "model.created", "targetId": "…",
  "providerId": "…", "enabled": false, "msg": "ai catalog change" }
```

A catalog change alters what **every** tenant can select, so it has to be answerable to "who
did this?". v1 has **no audit table and no audit endpoint** — that is a deliberate scope
decision — so this record is the whole of the trail. It is written by the controller, the only
layer that knows the actor, and it carries no credential and no provider-native id: only the
catalog's own uuid, which is what a durable audit table would reference anyway. A **denied** or
**rejected** request logs nothing, because nothing changed.

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

**Choosing a bot's model reuses `bots:manage`.** `PATCH /bots/:botId/model` introduces no new
permission: assigning a model is a bot-management action, so it is gated on the permission that
already covers renaming a bot (OWNER and ADMIN). An AGENT therefore cannot select a model, and
cannot gain that ability without first gaining bot management. The workspace-facing catalog
read (`GET /ai/models`) is authenticated but carries **no** permission gate — the list is
identical for every caller and contains no tenant data, so the authorization that matters is on
the write path, not on reading the options.

The permission check runs **after** validation: `validate()` sits before
`requireWorkspacePermission(...)` on that route, so a provider-native id in place of a catalog
uuid is a **400 for every role**, never a 403 that would hint the check is what failed.

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

The matrix covers the AI catalog routes too, including the two properties that are easy to lose
in a refactor: `providerModelId` and `slug` are **write-once** (a `PATCH` carrying either is a
400, not a silent strip), and the provider-native id **never appears in a workspace-facing
projection**.

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

When a bot has a model assigned, the conversation service resolves **`providerModelId` and the
provider slug** and sends them to the AI service alongside the message. That resolution happens
here, in Node, and the resulting native id travels only on the **server-to-server** call behind
`X-API-Key` — it is never returned to a client. A bot with **no** model assigned sends no
override at all, and the AI service falls back to its own configured default: that is the
pre-catalog behaviour, preserved exactly.

**The server holds no provider credential.** There is no `OPENROUTER_API_KEY`,
`GROQ_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `OPENAI_COMPATIBLE_API_KEY` in
`src/config/env.ts` and none is expected — provider keys live only in the Python service's
environment. This is why the platform catalog reports readiness rather than probing a provider:
Node has nothing to probe with, and deliberately never will.

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
  workspace (404); cross-tenant read → 404; model assignment rejects an unknown, a disabled,
  and a provider-disabled model with 400; a provider-native id is 400 for every role.
- **conversation** — create under an owned bot; `sendMessage` stores USER + ASSISTANT and calls
  the AI boundary once; cross-tenant post → 404 and the AI service is **never** called; empty
  message → 400.
- **ai-catalog** — the full platform lifecycle (create → enable → assign → disable → re-enable),
  the disable-after-assignment path, delete-while-referenced → 409, one attribution record per
  catalog change, and a recursive scan of both catalog payloads asserting **no
  credential-shaped key or value** appears anywhere in them.
- **rbac-matrix** — every role × every route, including the catalog routes, the write-once
  identity fields, and the provider-native id's absence from workspace-facing projections.

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
