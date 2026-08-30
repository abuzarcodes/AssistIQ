import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/errors.js';
import type { AIKnowledgeItem } from '../types/common.types.js';

// Define the payload structures based on Python FastAPI endpoints
export interface ChatPayload {
  bot_id: string;
  message: string;
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

const AI_REQUEST_TIMEOUT_MS = process.env.AI_SERVICE_TIMEOUT ? parseInt(process.env.AI_SERVICE_TIMEOUT) : 30000;

class AIServiceClient {
  private get baseUrl() {
    if (!env.AI_SERVICE_URL) {
      throw new AppError('AI_SERVICE_URL is not configured in the environment variables.', 500);
    }
    return env.AI_SERVICE_URL;
  }

  private get headers() {
    return {
      'Content-Type': 'application/json',
      // If there is an API key mechanism in the future, add it here
    };
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
        let errorMsg = `AI service responded with status ${response.status}`;
        try {
          const errorBody = await response.json() as { detail?: any };
          if (errorBody && errorBody.detail) {
             errorMsg += `: ${typeof errorBody.detail === 'string' ? errorBody.detail : JSON.stringify(errorBody.detail)}`;
          }
        } catch (e) {
           // ignore json parse error
        }
        logger.error({ status: response.status, url }, 'AI Service Error');
        throw new Error(errorMsg);
      }

      return (await response.json()) as T;
    } catch (error) {
      logger.error({ err: error, url }, 'AI service communication failed');
      if (error instanceof AppError) throw error;
      throw new AppError('The AI service is currently unavailable. Please try again later.', 502);
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
   */
  private async requestFormData<T>(endpoint: string, formData: FormData): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS * 3), // longer timeout for file uploads
      });

      if (!response.ok) {
        let errorMsg = `AI service responded with status ${response.status}`;
        try {
          const errorBody = await response.json() as { detail?: any };
          if (errorBody && errorBody.detail) {
            errorMsg += `: ${typeof errorBody.detail === 'string' ? errorBody.detail : JSON.stringify(errorBody.detail)}`;
          }
        } catch (e) {
          // ignore json parse error
        }
        logger.error({ status: response.status, url }, 'AI Service FormData Error');
        throw new Error(errorMsg);
      }

      return (await response.json()) as T;
    } catch (error) {
      logger.error({ err: error, url }, 'AI service FormData communication failed');
      if (error instanceof AppError) throw error;
      throw new AppError('The AI service is currently unavailable. Please try again later.', 502);
    }
  }

  public async ingestDocument(formData: FormData): Promise<any> {
    return this.requestFormData<any>('/api/v1/knowledge/ingest-document', formData);
  }
}

export const aiServiceClient = new AIServiceClient();
