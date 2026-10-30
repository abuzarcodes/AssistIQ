import { z } from 'zod';

export const CLIENT_EVENT_TYPES = ['page_view', 'chat_start'] as const;

export const clientEventSchema = z.object({
  eventType: z.enum(CLIENT_EVENT_TYPES),
  sessionId: z.string().trim().max(64).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ClientEventInput = z.infer<typeof clientEventSchema>;

export const analyticsQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export type AnalyticsQueryInput = z.infer<typeof analyticsQuerySchema>;

export const deploymentAnalyticsParamSchema = z.object({
  botId: z.string().uuid('Invalid bot id'),
  deploymentId: z.string().uuid('Invalid deployment id'),
});
