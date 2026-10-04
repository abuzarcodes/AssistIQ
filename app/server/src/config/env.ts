import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

// Load .env from the server root before anything reads process.env.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/**
 * Schema for all environment variables the backend depends on.
 * Critical secrets (DATABASE_URL, JWT_SECRET) are required — the process refuses
 * to start without them, so we never "silently run" with missing secrets (spec §19).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // AI/ML service boundary (the Python FastAPI service).
  AI_SERVICE_URL: z.string().url().optional().or(z.literal('')),
  // Per-request timeout in milliseconds for calls to the AI service.
  AI_SERVICE_TIMEOUT: z.coerce.number().int().positive().default(30000),
  /**
   * Timeout for a single document-ingestion call inside a batch upload.
   *
   * Longer than `AI_SERVICE_TIMEOUT` because one file's extraction + chunking + embedding
   * is slow, and a batch of N files runs ceil(N / concurrency) of these in sequence, so
   * the request has to outlive the lot. The `.max()` is a hard cap: a mis-set environment
   * value must not be able to produce a request that waits indefinitely.
   */
  AI_SERVICE_UPLOAD_BATCH_TIMEOUT: z.coerce.number().int().positive().max(600000).default(300000),
  // Shared secret the Python service requires in the `X-API-Key` header (Checkpoint 5).
  AI_SERVICE_API_KEY: z.string().optional(),

  // RBAC: the email of the user promoted to PLATFORM_OWNER by the seed script.
  // Optional — when unset the seed simply skips platform-owner promotion.
  PLATFORM_OWNER_EMAIL: z.string().email().optional().or(z.literal('')),

  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Logger depends on env, so we cannot use it here. Fail loudly and exit.
  console.error(`❌ Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
