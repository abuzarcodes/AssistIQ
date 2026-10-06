import { apiPost, apiGet, apiPatch, apiDelete, apiPostFormData } from '@/lib/api-client';

export interface KnowledgeEntry {
  id: string;
  botId: string;
  title: string | null;
  category: string | null;
  question: string;
  answer: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKnowledgeData {
  title?: string;
  category?: string;
  question: string;
  answer: string;
}

export interface UpdateKnowledgeData {
  title?: string;
  category?: string;
  question?: string;
  answer?: string;
}

export interface DocumentUploadResult {
  success: boolean;
  bot_id: string;
  filename: string;
  pages_extracted: number;
  chunks_created: number;
  status: string;
}

export function listKnowledge(botId: string) {
  return apiGet<KnowledgeEntry[]>(`/bots/${botId}/knowledge`);
}

export function createKnowledge(botId: string, data: CreateKnowledgeData) {
  return apiPost<KnowledgeEntry>(`/bots/${botId}/knowledge`, data);
}

export function updateKnowledge(knowledgeId: string, data: UpdateKnowledgeData) {
  return apiPatch<KnowledgeEntry>(`/knowledge/${knowledgeId}`, data);
}

export function deleteKnowledge(knowledgeId: string) {
  return apiDelete<null>(`/knowledge/${knowledgeId}`);
}

export function deleteAllKnowledge(botId: string) {
  return apiDelete<null>(`/bots/${botId}/knowledge`);
}

export function uploadDocument(botId: string, file: File, topic?: string) {
  const formData = new FormData();
  formData.append('file', file);
  if (topic) {
    formData.append('topic', topic);
  }
  return apiPostFormData<DocumentUploadResult>(
    `/bots/${botId}/knowledge/upload-document`,
    formData,
  );
}
