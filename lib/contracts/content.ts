import { z } from 'zod';

export const contentPolicy = 'content-policy-v2';
export const domains = [
  'cpp',
  'python',
  'algorithms',
  'systems',
  'performance',
  'networking',
  'distributed',
  'engineering',
] as const;
export const categories = [
  'Explain',
  'Predict',
  'Debug',
  'Compare',
  'Design',
  'Critique',
] as const;
export const domainSchema = z.enum(domains);
export const categorySchema = z.enum(categories);
export const catalogQuerySchema = z
  .object({
    domain: domainSchema.optional(),
    category: categorySchema.optional(),
    cursor: z.string().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export const catalogEntrySchema = z
  .object({
    id: z.uuid(),
    stableId: z.string().min(1).max(100),
    version: z.number().int().positive(),
    title: z.string().min(1).max(200),
    domain: domainSchema,
    category: categorySchema.nullable(),
    qualificationPolicy: z.literal(contentPolicy),
    uncalibrated: z.literal(true),
  })
  .strict();
export const catalogPageSchema = z
  .object({
    entries: z.array(catalogEntrySchema).max(50),
    catalogRevision: z.string().regex(/^\d+$/),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const termDefinitionSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    definition: z.string(),
    intuition: z.string(),
    example: z.string(),
  })
  .strict();
export const linkedTermsSchema = z.array(
  z.object({ id: z.uuid(), title: z.string() }).strict(),
);
export const vocabularyLookupSchema = z
  .object({ key: z.uuid(), itemId: z.uuid(), termId: z.uuid() })
  .strict();
export type CatalogPage = z.infer<typeof catalogPageSchema>;
