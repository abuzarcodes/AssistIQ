import { z } from 'zod';

export const isValidDomain = (domain: string): boolean => {
  if (!domain || domain.length > 253) return false;
  if (
    domain.includes('://') ||
    domain.includes('/') ||
    domain.includes(':') ||
    domain.includes(' ') ||
    domain.includes('?') ||
    domain.includes('#')
  ) {
    return false;
  }
  if (domain === 'localhost') return true;
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
};

export const isValidSlug = (slug: string): boolean => {
  if (!slug || slug.length < 3 || slug.length > 80) return false;
  const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  return slugRegex.test(slug);
};

export const botDeploymentParamSchema = z.object({
  botId: z.string().uuid('Invalid bot id'),
  deploymentId: z.string().uuid('Invalid deployment id'),
});

export const updateDeploymentSchema = z
  .object({
    enabled: z.boolean().optional(),
    slug: z
      .string()
      .trim()
      .min(3, 'Slug must be at least 3 characters')
      .max(80, 'Slug cannot exceed 80 characters')
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        'Slug must be lowercase alphanumeric characters separated by single hyphens'
      )
      .optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine(
    (data) => data.enabled !== undefined || data.slug !== undefined,
    { message: 'Provide at least one deployment setting to update.' }
  );

export type UpdateDeploymentInput = z.infer<typeof updateDeploymentSchema>;

export const addDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Domain is required')
    .max(253, 'Domain cannot exceed 253 characters')
    .refine(isValidDomain, {
      message:
        'Invalid domain format. Provide a valid hostname without protocol, port, or path (e.g. example.com).',
    }),
});

export type AddDomainInput = z.infer<typeof addDomainSchema>;

export const removeDomainParamSchema = z.object({
  botId: z.string().uuid('Invalid bot id'),
  deploymentId: z.string().uuid('Invalid deployment id'),
  domainId: z.string().optional(),
});

export const removeDomainQueryOrBodySchema = z
  .object({
    domain: z.string().trim().optional(),
    domainId: z.string().optional(),
  })
  .optional();
