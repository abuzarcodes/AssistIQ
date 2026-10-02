# AssistIQ AI Service - Hybrid AI Engine (Review 1)

This is the independent Python FastAPI microservice powering the Intelligence Layer of the **AssistIQ** customer support platform. 

## Architecture

This service implements a deterministic hybrid AI pipeline to answer customer questions accurately without hallucinations.

The pipeline follows this exact flow:
1. **Classify**: Incoming messages are evaluated by an ML Intent Classifier (`TF-IDF + LogisticRegression`).
2. **Route**: If confidence is high, search is filtered to a specific topic. If low, a full search is performed.
3. **Retrieve**: pgvector performs semantic search using embeddings (`OpenAI` or `HuggingFace Sentence Transformers`).
4. **Validate**: If retrieval confidence is below threshold, the system gracefully falls back.
5. **Generate**: The LLM (`OpenAI`, `Gemini`, `Grok`, or a **catalog provider** such as `OpenRouter`) generates a response grounded *strictly* in the retrieved context.
6. **Fallback**: If the LLM lacks sufficient information, it returns an explicit `INSUFFICIENT_INFORMATION` signal, triggering a graceful fallback.

Step 5 has **two paths**, and which one runs is decided by the request, not by this service.
A request carrying a `model` descriptor runs on that provider via the [provider layer](#provider-layer-model-catalog);
a request without one runs on the service's environment-configured default — the behaviour of
every request before the catalog existed, preserved exactly. The classifier, retrieval and
fallback logic are **identical** on both paths. Nothing about the ML/RAG pipeline changed.

## Prerequisites

1. **Python 3.10+**
2. **PostgreSQL with pgvector** — the RAG pipeline stores embeddings in a `vector` column, so
   the database must have the `vector` extension available. A plain `postgres` image does
   **not** ship it. This service keeps its vector store in its own instance, separate from the
   application database the Express server owns; [`docker-compose.yml`](docker-compose.yml)
   starts a `pgvector/pgvector:pg16` container on port **5433** for it. The AI service creates
   the extension and the `knowledge_chunks` table itself on startup.
3. API Keys (Optional if using free tiers):
   - OpenAI (for embeddings/LLM)
   - Gemini / Google AI Studio (Free LLM tier)
   - Grok / xAI (Free LLM tier)
   - OpenRouter (for catalog models — see [Provider layer](#provider-layer-model-catalog))

## Setup

1. **Start the vector store**:
   ```bash
   docker compose up -d      # pgvector on localhost:5433
   ```
   Its password comes from `VECTOR_DB_PASSWORD` in `.env` and must match the password in
   `DATABASE_URL`. Getting this wrong is not silent: ingestion fails with a 500 rather than
   reporting zero chunks stored.

2. **Create Virtual Environment**:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   ```

3. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure Environment**:
   Copy `.env.example` to `.env` and fill in your keys. To run completely free:
   - `LLM_PROVIDER="gemini"` (Get key from Google AI Studio)
   - `EMBEDDING_PROVIDER="huggingface"` (Runs locally, no key needed)

5. **Train the ML Model**:
   You must train the intent classifier before starting the server.
   ```bash
   python -m app.ml.training.train
   ```

6. **Run the Server**:
   ```bash
   uvicorn app.main:app --reload --port 8000
   ```

Verify the store is reachable — this should report `"status": "connected"` with a chunk count,
not `"disconnected"`:

```bash
curl -H "X-API-Key: $AI_SERVICE_API_KEY" http://localhost:8000/api/v1/testing/vector-store/stats
```

## Provider layer (model catalog)

**This service is where the only provider credential lives.** The Node backend owns the
*catalog* — which providers and models exist, and which are enabled — but holds no provider
key of any kind. It stores a provider **slug** and a model id; this service maps the slug to
the credential. That asymmetry is what keeps the key out of the application database, out of
Node's logs, and off the wire to the browser.

### The descriptor

When a bot has a catalog model assigned, Node resolves it and sends a descriptor on
`POST /api/v1/chat`:

```jsonc
{
  "bot_id": "…",
  "message": "…",
  "model": { "provider": "openrouter", "model_id": "openai/gpt-4o-mini" }
}
```

`model` is **optional**. Absent means the request runs on the environment-configured default
(`LLM_PROVIDER` + `LLM_MODEL`) — byte-for-byte the pre-catalog behaviour.

### The trust boundary

Python validates the **first half** of the descriptor — the provider slug, against the
registry. It deliberately cannot validate the second half: this service holds no catalog, no
connection to the Node database, and no notion of which models an operator enabled. That is
intentional and load-bearing.

- **Node** is the sole authority on model enablement, and re-reads catalog state on **every
  message**, so a disable takes effect on the next message with no restart and no cache to
  invalidate.
- **Python** trusts the slug only far enough to pick an adapter, and trusts `model_id` not at
  all beyond passing it to that adapter.

> **Do not add a "known models" list to this service.** A second copy of catalog state is a
> second thing that can disagree with the first. A model id that looks wrong is not rejected
> here — it surfaces at call time as a `BAD_REQUEST` from the provider, which the Node-side
> failure policy already maps to `MODEL_UNAVAILABLE`.

### Layout

| File | Role |
| ---- | ---- |
| [`app/providers/base.py`](app/providers/base.py) | The adapter contract (`LLMProvider`), the descriptor (`ProviderModelRef`), and the typed failure vocabulary (`ProviderErrorKind`, `ProviderError`). |
| [`app/providers/registry.py`](app/providers/registry.py) | The one place a slug becomes an adapter. Built-ins load lazily on first lookup, keyed by slug; a duplicate slug **raises** rather than resolving to whichever imported last. |
| [`app/providers/openrouter.py`](app/providers/openrouter.py) | The first adapter. OpenRouter speaks the OpenAI wire protocol, so it is `ChatOpenAI` aimed at OpenRouter's base URL. |

### The adapter contract

An adapter is anything with three members — a `Protocol`, not a base class, because adapters
differ in how they talk to their vendor and the rest of the service needs only this:

```python
class LLMProvider(Protocol):
    slug: str                                  # must match ai_providers.slug; never changes
    @property
    def is_configured(self) -> bool: ...       # credential present? no network call
    async def generate(self, prompt, model_id,
                       system_message=None, temperature=0.0) -> str: ...
```

- **`slug`** is the join key to the catalog. It must match the `ai_providers.slug` column and
  must **never** change once shipped — changing it silently unlinks every catalog row.
- **`is_configured`** must stay cheap and side-effect free. It is what `GET /ai/status`
  reports, the dashboard polls that route, and a vendor request from a status endpoint would
  be both a cost and a lie.
- **`generate`** must **raise `ProviderError`**, never return an error string. Node's failure
  policy branches on the kind, and a string that merely looks like a failure would be
  indistinguishable from a real answer.

### Failure kinds

Adapters classify failures into *kinds*, not statuses — several HTTP statuses collapse into
one kind, because what the operator can do about them is identical.

| Kind | Raised when | Mapped by Node to |
| ---- | ----------- | ----------------- |
| `NOT_CONFIGURED` | No credential present. Detected before any network call. | `MODEL_UNAVAILABLE` |
| `AUTH` | Provider rejected the credential (`401`/`402`/`403` — a permission denial is remedied by the same operator action as a rejected key). | `MODEL_UNAVAILABLE` |
| `RATE_LIMIT` | Throttled. Retrying later is the only sane response. | `MODEL_RATE_LIMITED` |
| `UPSTREAM` | Provider failed on its side (`5xx`). | `MODEL_UNAVAILABLE` |
| `TIMEOUT` | The request did not complete within `OPENROUTER_REQUEST_TIMEOUT`. | `MODEL_UNAVAILABLE` |
| `BAD_REQUEST` | Provider rejected the request itself (`400`) — usually a bad model id. | `MODEL_UNAVAILABLE` |
| `UNKNOWN_PROVIDER` | The descriptor named a slug with no adapter. | `MODEL_UNAVAILABLE` |
| `UNKNOWN` | Anything else. Deliberately a bucket rather than a guess. | `MODEL_ERROR` |

Every `ProviderError` carries one of a set of **fixed, non-echoing messages**. A provider
exception's own text is never used as the message: it can contain the request URL, headers, or
fragments of the prompt. The original exception is kept on `cause` for logs only. The error's
`details` carry the provider slug and model id — both public identifiers that already appear in
the platform dashboard — and **no credential-derived value may ever be added there**.

### Environment variables

Read from this service's `.env` only. The Node backend has **no** OpenRouter variable.

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `OPENROUTER_API_KEY` | `""` | The credential. Empty means **adapter available, credential absent** — a state the dashboard reports rather than hides, so an operator can tell "not wired up yet" from "wired up and broken". |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter's OpenAI-compatible endpoint. |
| `OPENROUTER_REQUEST_TIMEOUT` | `30.0` | Seconds to wait for a completion. A provider that never answers must not hold a conversation open indefinitely; the timeout surfaces as a `TIMEOUT` `ProviderError`. |
| `OPENROUTER_SITE_URL` | `""` | OpenRouter's optional `HTTP-Referer` attribution header. |
| `OPENROUTER_APP_NAME` | `AssistIQ` | OpenRouter's optional `X-Title` attribution header. |

The two attribution headers are identifiers shown on the provider's own dashboard. They are
**never** credentials.

### Readiness: two independent axes

`GET /api/v1/ai/status` reports every registered adapter and whether its credential is present:

```jsonc
{
  "llm_provider": "gemini",
  "provider_adapters": [
    { "slug": "openrouter", "configured": true }
  ]
}
```

Those are two genuinely independent questions, and the dashboard keeps them separate:

| Axis | Source | A "no" means |
| ---- | ------ | ------------ |
| **Adapter available** | the slug appears in the registry | a **deployment** problem — ship an adapter |
| **Credential configured** | the adapter's `is_configured` | a **configuration** problem — set the key |

Collapsing them into one "health" dot would hide which one is wrong. **Neither axis measures
live reachability**: no dashboard request contacts a provider. A configured-but-revoked key
still reads `configured: true` until the provider is actually called at chat time, where it
surfaces as `MODEL_UNAVAILABLE`. That is a deliberate scope decision, not an oversight — and
`provider_adapters` is **additive**, so a client that ignores it sees the pre-existing
response shape unchanged.

---

## Demo & Testing Endpoints

Once the server is running, visit `http://localhost:8000/docs` to interact with Swagger UI.

1. **`GET /api/v1/testing/status`**: System status report.
2. **`GET /api/v1/ml/evaluate`**: See the real F1, Precision, and Recall scores of the intent classifier.
3. **`POST /api/v1/knowledge/ingest`**: Ingest JSON FAQ data for a `bot_id`. It will be chunked and saved to pgvector.
4. **`POST /api/v1/chat`**: Send a message to the full pipeline. The response includes `intent` and `retrieval` metadata. Accepts an optional `model` descriptor — see [Provider layer](#provider-layer-model-catalog).
5. **`POST /api/v1/testing/chat-pipeline`**: Extremely detailed debug endpoint showing raw inputs, chunks, strategy, and prompts.
6. **`GET /api/v1/ai/status`**: Provider status, including each registered adapter's credential state.

## Multi-Tenancy

Every API endpoint requires a `bot_id`. The vector database strictly isolates searches using `WHERE bot_id = ?`. One tenant's data can never be exposed to another.

Every endpoint also requires the `X-API-Key` header — the shared secret the Node backend
presents. There is no disabled mode: with no key configured the service refuses **every**
protected request with a `503` rather than accepting unauthenticated traffic. `/health` is the
only route left open, so probes keep working.
