import { z } from 'zod';

export const createKnowledgeSchema = z.object({
  title: z.string().trim().max(200).optional(),
  category: z.string().trim().max(120).optional(),
  question: z.string().trim().min(1, 'Question is required').max(2000),
  answer: z.string().trim().min(1, 'Answer is required').max(10000),
});

export const updateKnowledgeSchema = z
  .object({
    title: z.string().trim().max(200).nullable().optional(),
    category: z.string().trim().max(120).nullable().optional(),
    question: z.string().trim().min(1, 'Question cannot be empty').max(2000).optional(),
    answer: z.string().trim().min(1, 'Answer cannot be empty').max(10000).optional(),
  })
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

export const knowledgeIdParamSchema = z.object({
  knowledgeId: z.string().uuid('Invalid knowledge id'),
});

export type CreateKnowledgeInput = z.infer<typeof createKnowledgeSchema>;
export type UpdateKnowledgeInput = z.infer<typeof updateKnowledgeSchema>;
