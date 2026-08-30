import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/errors.js';
import type { AIRequestInput, AIResponse, AIKnowledgeItem } from '../types/common.types.js';

/**
 * AI service boundary (spec §15).
 *
 * This module is the ONLY place that talks to the AI/ML service. Controllers and other
 * services depend only on `generateResponse` + the `AIResponse` contract, so swapping the
 * Review 1 mock for the real Python/FastAPI service is a config change (AI_SERVICE_MODE),
 * not a refactor. The module is intentionally DB-free — the conversation service supplies
 * whatever grounding knowledge the AI needs.
 */

// --- Mock implementation (Review 1 default) --------------------------------------------
// A deliberately simple, dependency-free keyword-overlap match against the bot's FAQ.
// This is NOT machine learning — it only demonstrates the request/response flow and the
// escalation signal the real service will eventually provide.

const tokenize = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );

/** Cosine-like overlap of two token sets, in [0, 1]. */
const overlapScore = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / Math.sqrt(a.size * b.size);
};

const MATCH_THRESHOLD = 0.3;

const mockAIResponse = (input: AIRequestInput): AIResponse => {
  const messageTokens = tokenize(input.message);

  let best: { entry: AIKnowledgeItem; score: number } | null = null;
  for (const entry of input.knowledge) {
    const score = Math.max(
      overlapScore(messageTokens, tokenize(entry.question)),
      overlapScore(messageTokens, tokenize(entry.title ?? ''))
    );
    if (!best || score > best.score) {
      best = { entry, score };
    }
  }

  if (best && best.score >= MATCH_THRESHOLD) {
    return {
      answer: best.entry.answer,
      intent: 'faq_match',
      confidence: Number(best.score.toFixed(2)),
      shouldEscalate: false,
    };
  }

  return {
    answer:
      "I'm not sure I have an answer for that yet. I can connect you with a support specialist who can help.",
    intent: 'fallback',
    confidence: best ? Number(best.score.toFixed(2)) : 0,
    shouldEscalate: true,
  };
};

// --- Live implementation (future Python/FastAPI service) -------------------------------

const AI_REQUEST_TIMEOUT_MS = 15_000;

const liveAIResponse = async (input: AIRequestInput): Promise<AIResponse> => {
  if (!env.AI_SERVICE_URL) {
    throw new AppError('AI service URL is not configured', 500);
  }

  try {
    const response = await fetch(`${env.AI_SERVICE_URL}/api/v1/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.AI_SERVICE_API_KEY ? { 'x-api-key': env.AI_SERVICE_API_KEY } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`AI service responded with status ${response.status}`);
    }

    return (await response.json()) as AIResponse;
  } catch (error) {
    // Log the failure (spec §21) but never surface internal details to the client.
    logger.error({ err: error, botId: input.botId }, 'AI service communication failed');
    throw new AppError('The AI service is currently unavailable. Please try again later.', 502);
  }
};

/**
 * Generate an AI answer for a customer message. Chooses mock vs live based on
 * AI_SERVICE_MODE. In mock mode the backend runs fully offline (spec §15).
 */
export const generateResponse = (input: AIRequestInput): Promise<AIResponse> => {
  if (env.AI_SERVICE_MODE === 'live') {
    return liveAIResponse(input);
  }
  return Promise.resolve(mockAIResponse(input));
};
