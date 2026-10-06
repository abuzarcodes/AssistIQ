import { apiPost, apiGet } from '@/lib/api-client';

/* ---------- Classify ---------- */
export interface ClassifyResponse {
  predicted_intent: string;
  confidence: number;
  top_predictions: { intent: string; confidence: number }[];
}

export function classify(text: string) {
  return apiPost<ClassifyResponse>('/admin/ai/classify', { text });
}

/* ---------- Status ---------- */
export function getAiStatus() {
  return apiGet<Record<string, unknown>>('/admin/ai/status');
}

export function getMlStatus() {
  return apiGet<Record<string, unknown>>('/admin/ai/ml-status');
}

export function getTestingStatus() {
  return apiGet<Record<string, unknown>>('/admin/ai/testing/status');
}

/* ---------- ML Evaluate ---------- */
export interface MlEvaluationResponse {
  status: string;
  model_status: string;
  accuracy: number;
  precision: number;
  recall: number;
  f1_score: number;
  classification_report: Record<string, unknown>;
}

export function evaluateMl() {
  return apiGet<MlEvaluationResponse>('/admin/ai/ml-evaluate');
}

/* ---------- RAG Search ---------- */
export interface RagSearchResult {
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface RagSearchResponse {
  query: string;
  results: RagSearchResult[];
}

export function ragSearch(data: { bot_id: string; query: string; top_k?: number; topic_filter?: string }) {
  return apiPost<RagSearchResponse>('/admin/ai/rag/search', data);
}

/* ---------- Pipeline Debug ---------- */
export interface PipelineDebugResponse {
  input: Record<string, string>;
  classification: Record<string, unknown>;
  retrieval_strategy: Record<string, unknown>;
  retrieval_results: Record<string, unknown>[];
  retrieval_confidence: Record<string, unknown>;
  generation: Record<string, unknown> | null;
  final_result: Record<string, unknown>;
}

export function debugPipeline(data: { bot_id: string; message: string }) {
  return apiPost<PipelineDebugResponse>('/admin/ai/debug/chat-pipeline', data);
}

/* ---------- Vector Stats ---------- */
export interface VectorStatsResponse {
  status: string;
  total_chunks: number;
  bots_indexed: number;
  details: Record<string, unknown>;
}

export function getVectorStats() {
  return apiGet<VectorStatsResponse>('/admin/ai/vector-stats');
}
