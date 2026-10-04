import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError, AIServiceError } from '../utils/errors.js';

/** The catalog model Node resolved for a bot, in the shape Python's provider layer takes. */
export interface ChatModelDescriptor {
  provider: string;
  model_id: string;
}

/**
 * The bot configuration as the AI service receives it (plan §11.1).
 *
 * Snake-cased and **deliberately narrow**: only the fields the pipeline can act on. Welcome
 * messages, suggested questions, business hours, feedback flags and contact fields are
 * client rendering and Node policy — sending them would invite the AI service to grow an
 * opinion about product behaviour, which is the boundary this design rests on (§11.6).
 */
export interface PythonBotConfig {
  personality: string;
  tone: string;
  custom_personality: string | null;
  custom_instructions: string | null;
  response_language: string;
  response_length: string;
  knowledge: {
    enabled: boolean;
    strictness: string;
    show_sources: boolean;
    top_k: number;
  };
  params: {
    temperature: number;
    top_p: number | null;
    frequency_penalty: number | null;
    presence_penalty: number | null;
    max_tokens: number | null;
  };
  fallback: { message: string | null };
}

/**
 * A knowledge citation as the AI service returns it (plan §15.3).
 *
 * **Identifiers only** — no score, no content. Node resolves the display label from its own
 * mirrored `KnowledgeSource` rows, so the metadata authority stays in Node and the client
 * learns *which document* an answer came from, never *how well* it scored.
 */
export interface PythonSourceRef {
  chunk_id: string;
  source_id: string | null;
  topic: string | null;
  page_number: number | null;
}

// Define the payload structures based on Python FastAPI endpoints
export interface ChatPayload {
  bot_id: string;
  message: string;
  /**
   * The model this bot is assigned, or **absent** when it has none (Checkpoint 6).
   *
   * Optional and omitted rather than sent as `null`: a bot with no assignment must produce
   * the exact payload it produced before this field existed, and `undefined` is the only
   * value that leaves the key out of the serialised request entirely.
   *
   * Built only by `botModelResolver` from the bot row. It is never populated from request
   * input, which is the structural reason a client cannot name a model directly.
   */
  model?: ChatModelDescriptor;
  /**
   * The failover model, present only when the bot has one configured and usable (§13.2).
   * Python retries the generation step once with it; Node resolves it, Python never chooses.
   */
  fallback_model?: ChatModelDescriptor;
  /**
   * The bot's resolved configuration. Absent only for a caller that predates the feature —
   * Python treats `config=None` as legacy behaviour, not "the defaults" (§11.1).
   */
  config?: PythonBotConfig;
}

export interface ChatResponse {
  status: string;
  response: string;
  fallback_required: boolean;
  intent?: {
    predicted: string;
    confidence: number;
  };
  retrieval?: {
    used_topic_filter: boolean;
    top_score: number;
    documents_found: number;
  };
  reason?: string;
  /** Knowledge citations, present only when the bot asked for them (§15.3). */
  sources?: PythonSourceRef[];
  /**
   * The model that produced the answer, as `provider:model_id`. **Node-only** — logged and
   * reported, never forwarded into a client-facing payload (§13.6).
   */
  model_used?: string;
  /** Whether the fallback model served this turn. Node-only, like `model_used`. */
  failover_used?: boolean;
  /** Whether the customer explicitly asked for a human. Node applies `humanRequestBehavior`. */
  human_requested?: boolean;
}

export interface IngestPayload {
  bot_id: string;
  entries: {
    id: string;
    topic: string;
    content: string;
  }[];
}

export interface ClassifyPayload {
  text: string;
}

export interface ClassifyResponse {
  intent: string;
  confidence: number;
}

/** One chunk as reported by the AI service after a document ingestion. */
export interface DocumentIngestChunk {
  id: string;
  chunk_index: number;
  content: string;
  page_number: number | null;
  topic: string | null;
}

/** Response from `POST /api/v1/knowledge/ingest-document`. */
export interface DocumentIngestResponse {
  success: boolean;
  bot_id: string;
  filename: string;
  pages_extracted: number;
  chunks_created: number;
  status: string;
  /** Model and dimension actually used, recorded on the mirrored chunk rows. */
  embedding_model: string;
  embedding_dimension: number;
  /**
   * Per-chunk detail. The server cannot discover these ids any other way — the vectors
   * live in a different database from the `KnowledgeSource` row that owns them.
   */
  chunks: DocumentIngestChunk[];
  /**
   * Present only if the AI service answers 200 with `success: false`. In practice a
   * failure there is an HTTP error and `requestFormData` throws with the `detail`, so
   * this is a defensive field — `ingestFile` checks `success` regardless rather than
   * trusting the status code alone.
   */
  error?: string;
}

/** Response from the chunk re-embed endpoint. */
export interface ReEmbedResponse {
  success: boolean;
  chunk_id: string;
  embedding_model: string;
  embedding_dimension: number;
}

const AI_REQUEST_TIMEOUT_MS = env.AI_SERVICE_TIMEOUT;

/**
 * Timeout for a single document-ingestion call.
 *
 * Kept at 3× the normal request timeout for the single-file route, which is what it has
 * always been. Batch ingestion passes `AI_SERVICE_UPLOAD_BATCH_TIMEOUT` explicitly
 * instead, because a batch holds the request open through several sequential AI calls.
 * That setting is capped in `env.ts`, so neither value can be configured into an
 * indefinite wait.
 */
const AI_UPLOAD_TIMEOUT_MS = AI_REQUEST_TIMEOUT_MS * 3;

class AIServiceClient {
  private get baseUrl() {
    if (!env.AI_SERVICE_URL) {
      throw new AppError('AI_SERVICE_URL is not configured in the environment variables.', 500);
    }
    return env.AI_SERVICE_URL;
  }

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Service-to-service authentication (Checkpoint 5). The Python service rejects any
    // request without the shared secret, so a missing key fails loudly rather than
    // silently reaching an unprotected AI service.
    if (env.AI_SERVICE_API_KEY) {
      headers['X-API-Key'] = env.AI_SERVICE_API_KEY;
    }

    return headers;
  }

  private async request<T>(endpoint: string, options: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...this.headers,
          ...options.headers,
        },
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const detail = await this.readErrorDetail(response);
        logger.error({ status: response.status, url }, 'AI Service Error');
        throw this.upstreamError(response.status, detail);
      }

      return (await response.json()) as T;
    } catch (error) {
      logger.error({ err: error, url }, 'AI service communication failed');
      if (error instanceof AppError) throw error;
      // A timeout or a refused connection: the AI service never answered, so there is no
      // upstream status to carry and nothing to tell the user beyond "try again".
      throw new AIServiceError('The AI service is currently unavailable. Please try again later.');
    }
  }

  // --- Core Endpoints ---

  public async chat(payload: ChatPayload): Promise<ChatResponse> {
    return this.request<ChatResponse>('/api/v1/chat', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public async ingestKnowledge(payload: IngestPayload): Promise<any> {
    return this.request<any>('/api/v1/knowledge/ingest', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public async deleteBotKnowledge(botId: string): Promise<any> {
    return this.request<any>(`/api/v1/knowledge/${botId}`, {
      method: 'DELETE',
    });
  }

  public async classifyIntent(payload: ClassifyPayload): Promise<ClassifyResponse> {
    return this.request<ClassifyResponse>('/api/v1/ml/classify', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // --- Admin / Testing Endpoints ---

  public async searchVectors(payload: any): Promise<any> {
    return this.request<any>('/api/v1/rag/search', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  public async getAiStatus(): Promise<any> {
    return this.request<any>('/api/v1/ai/status', { method: 'GET' });
  }

  public async getMlStatus(): Promise<any> {
    return this.request<any>('/api/v1/ml/status', { method: 'GET' });
  }

  public async evaluateMlModel(): Promise<any> {
    return this.request<any>('/api/v1/ml/evaluate', { method: 'GET' });
  }

  public async getSystemStatus(): Promise<any> {
    return this.request<any>('/api/v1/testing/status', { method: 'GET' });
  }

  public async getVectorStats(): Promise<any> {
    return this.request<any>('/api/v1/testing/vector-store/stats', { method: 'GET' });
  }

  public async debugChatPipeline(payload: any): Promise<any> {
    return this.request<any>('/api/v1/testing/chat-pipeline', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Forward a FormData (multipart) request to the AI service.
   * Does NOT set Content-Type so fetch auto-generates the multipart boundary.
   * The API key is still sent — this path bypasses `this.headers`, so it must add
   * the credential itself or document uploads would be rejected by the AI service.
   *
   * `timeoutMs` overrides the default upload timeout. Batch ingestion passes the batch
   * timeout: one file's extraction+embedding is the slowest call in the system, and a
   * batch holds the request open through several of them, so the generous single-file
   * allowance would abort work the server is still doing (section 12.8).
   */
  private async requestFormData<T>(
    endpoint: string,
    formData: FormData,
    timeoutMs: number = AI_UPLOAD_TIMEOUT_MS
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: env.AI_SERVICE_API_KEY ? { 'X-API-Key': env.AI_SERVICE_API_KEY } : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const detail = await this.readErrorDetail(response);
        logger.error({ status: response.status, url }, 'AI Service FormData Error');
        throw this.upstreamError(response.status, detail);
      }

      return (await response.json()) as T;
    } catch (error) {
      logger.error({ err: error, url }, 'AI service FormData communication failed');
      if (error instanceof AppError) throw error;
      throw new AIServiceError('The AI service is currently unavailable. Please try again later.');
    }
  }

  /** Read the AI service's `detail` field, if it sent a JSON body and one is present. */
  private async readErrorDetail(response: Response): Promise<string | undefined> {
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body?.detail === 'string') return body.detail;
      if (body?.detail !== undefined) return JSON.stringify(body.detail);
    } catch {
      // A non-JSON error body (a proxy's HTML page, an empty response) carries nothing
      // usable; the status alone is the whole message.
    }
    return undefined;
  }

  /**
   * Build the error for a non-ok response.
   *
   * The status this throws is always 502 — the AI service failed to serve the request, and
   * that is the truth regardless of whose input was at fault. What varies is the message:
   * a 4xx carries the AI service's own explanation, because that is the only thing that
   * tells the user which file to fix. A 5xx keeps the generic text, because a dependency's
   * internal error is not the customer's business.
   */
  private upstreamError(status: number, detail?: string): AIServiceError {
    const isCallerFault = status >= 400 && status < 500;
    return new AIServiceError(
      isCallerFault && detail
        ? detail
        : 'The AI service is currently unavailable. Please try again later.',
      { status, detail }
    );
  }

  /**
   * Ingest one document.
   *
   * `batchTimeout` selects the longer batch allowance; the single-file route leaves it
   * unset and keeps the historical 3× default.
   */
  public async ingestDocument(
    formData: FormData,
    batchTimeout = false
  ): Promise<DocumentIngestResponse> {
    return this.requestFormData<DocumentIngestResponse>(
      '/api/v1/knowledge/ingest-document',
      formData,
      batchTimeout ? env.AI_SERVICE_UPLOAD_BATCH_TIMEOUT : AI_UPLOAD_TIMEOUT_MS
    );
  }

  // --- Chunk management (Checkpoint 2 of the document knowledge plan) ---
  //
  // Every chunk endpoint carries `bot_id`. The Python service scopes each statement to
  // `WHERE id = $1 AND bot_id = $2`, because chunk ids are not secret — the FAQ path
  // derives them from the bot id — so an id alone must never be enough to reach another
  // tenant's vector. Sending it is not optional; the AI service rejects the request
  // without it.

  /** Replace one chunk's text and regenerate its vector. */
  public async reEmbedChunk(botId: string, chunkId: string, content: string): Promise<ReEmbedResponse> {
    return this.request<ReEmbedResponse>(
      `/api/v1/knowledge/chunks/${encodeURIComponent(chunkId)}/re-embed?bot_id=${encodeURIComponent(botId)}`,
      { method: 'POST', body: JSON.stringify({ content }) }
    );
  }

  /** Enable or disable one chunk's vector. */
  public async toggleChunkEnabled(botId: string, chunkId: string, enabled: boolean): Promise<any> {
    return this.request<any>(
      `/api/v1/knowledge/chunks/${encodeURIComponent(chunkId)}/toggle?bot_id=${encodeURIComponent(botId)}`,
      { method: 'PATCH', body: JSON.stringify({ enabled }) }
    );
  }

  /** Delete one chunk's vector. */
  public async deleteChunkVector(botId: string, chunkId: string): Promise<any> {
    return this.request<any>(
      `/api/v1/knowledge/chunks/${encodeURIComponent(chunkId)}?bot_id=${encodeURIComponent(botId)}`,
      { method: 'DELETE' }
    );
  }

  /** Enable or disable several chunks' vectors in one call. */
  public async bulkToggleChunks(botId: string, chunkIds: string[], enabled: boolean): Promise<any> {
    return this.request<any>(
      `/api/v1/knowledge/chunks/bulk-toggle?bot_id=${encodeURIComponent(botId)}`,
      { method: 'POST', body: JSON.stringify({ chunk_ids: chunkIds, enabled }) }
    );
  }

  /** Delete several chunks' vectors in one call. */
  public async bulkDeleteChunks(botId: string, chunkIds: string[]): Promise<any> {
    return this.request<any>(
      `/api/v1/knowledge/chunks/bulk?bot_id=${encodeURIComponent(botId)}`,
      { method: 'DELETE', body: JSON.stringify({ chunk_ids: chunkIds }) }
    );
  }

  /**
   * Delete every vector belonging to one knowledge source.
   *
   * The Prisma cascade removes the `knowledge_sources` row and its chunk rows, but it
   * stops at the database boundary: the vectors are in a separate PostgreSQL instance.
   * This is the explicit second half of a source deletion — without it the vectors
   * outlive the source and keep being retrieved for a document the user deleted.
   */
  public async deleteSourceVectors(botId: string, sourceId: string): Promise<any> {
    return this.request<any>(
      `/api/v1/knowledge/sources/${encodeURIComponent(sourceId)}?bot_id=${encodeURIComponent(botId)}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Delete the vectors of several sources in one call.
   *
   * Used by "delete all FAQ entries", which must remove the FAQ vectors *and only those*.
   * `deleteBotKnowledge` would be one call instead of one, but it clears every vector the
   * bot owns — including the uploaded documents' — leaving the server's chunk rows
   * describing vectors that no longer exist, with the documents still listed and silently
   * unsearchable.
   */
  public async bulkDeleteSourceVectors(botId: string, sourceIds: string[]): Promise<any> {
    return this.request<any>(
      `/api/v1/knowledge/sources/bulk?bot_id=${encodeURIComponent(botId)}`,
      { method: 'DELETE', body: JSON.stringify({ source_ids: sourceIds }) }
    );
  }
}

export const aiServiceClient = new AIServiceClient();
