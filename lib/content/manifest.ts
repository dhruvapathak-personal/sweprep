import { createHash } from 'node:crypto';
import { z } from 'zod';
import { blockSchema } from '../contracts/study.ts';
import {
  categorySchema,
  contentPolicy,
  domainSchema,
} from '../contracts/content.ts';

const text = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = text.max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
function jsonbTextBytes(value: unknown): number {
  if (Array.isArray(value))
    return (
      2 +
      value.reduce((bytes, child) => bytes + jsonbTextBytes(child), 0) +
      Math.max(0, value.length - 1) * 2
    );
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    return (
      2 +
      entries.reduce(
        (bytes, [key, child]) =>
          bytes +
          Buffer.byteLength(JSON.stringify(key)) +
          2 +
          jsonbTextBytes(child),
        0,
      ) +
      Math.max(0, entries.length - 1) * 2
    );
  }
  return Buffer.byteLength(JSON.stringify(value));
}
export const sourceSchema = z
  .object({
    id: identity,
    role: z.enum(['discovery_context', 'correctness_evidence']),
    url: z.url().refine((value) => new URL(value).protocol === 'https:'),
    locator: text.max(1000),
    edition: text.max(200),
    accessedAt: z.iso.datetime(),
    intendedUse: text.max(1000),
    useMode: z.enum(['reference_only', 'permitted_reuse']),
    rightsBasis: text.max(2000).nullable(),
    attribution: text.max(2000).nullable(),
    payloadDigest: digest.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.useMode === 'permitted_reuse' &&
      (!value.rightsBasis || !value.attribution || !value.payloadDigest)
    )
      context.addIssue({
        code: 'custom',
        message: 'REUSE_RIGHTS_REQUIRED',
      });
    if (value.useMode === 'reference_only' && value.payloadDigest)
      context.addIssue({
        code: 'custom',
        message: 'REFERENCE_ONLY_HAS_PAYLOAD',
      });
  });
const claimSchema = z
  .object({
    claim: text.max(1000),
    sourceIds: z.array(identity).min(1).max(20),
  })
  .strict();
const termLink = z
  .object({
    termId: z.uuid(),
    required: z.boolean(),
    exposure: z.enum(['pre_attempt_safe', 'post_grade_only']),
  })
  .strict();
const common = {
  id: z.uuid(),
  stableId: identity,
  version: z.number().int().positive(),
  parentId: z.uuid().nullable(),
  origin: z.enum(['generation', 'seed', 'correction']),
  sources: z.array(sourceSchema).min(1).max(30),
  claims: z.array(claimSchema).min(1).max(30),
  dependencies: z.array(z.object({ id: z.uuid(), digest }).strict()).max(30),
  digest,
};
export const bundleSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...common,
        kind: z.literal('question'),
        payload: z
          .object({
            title: text.max(200),
            domain: domainSchema,
            category: categorySchema,
            skillId: identity,
            skill: text.max(100),
            secondarySkills: z.array(identity).max(10),
            assumptions: text.max(2000),
            prerequisites: z.array(identity).max(20),
            difficulty: z.number().int().min(1).max(5),
            blocks: z.array(blockSchema).min(1).max(20),
            promptVersion: identity,
            rubric: z
              .object({
                version: identity,
                passScore: z.number().int().min(1).max(5),
                requiredClaims: z.array(text.max(1000)).min(1).max(20),
                referenceAnswer: text.max(10000),
              })
              .strict(),
            terms: z.array(termLink).max(20),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('term'),
        payload: z
          .object({
            title: text.max(200),
            domain: domainSchema,
            definition: text.max(5000),
            intuition: text.max(5000),
            example: text.max(5000),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((bundle, context) => {
    if (jsonbTextBytes(bundle) > 100000)
      context.addIssue({ code: 'custom', message: 'BUNDLE_TOO_LARGE' });
    if (
      bundle.kind === 'question' &&
      jsonbTextBytes(bundle.payload.blocks) >= 20000
    )
      context.addIssue({ code: 'custom', message: 'BLOCKS_TOO_LARGE' });
    const sources = new Map(
      bundle.sources.map((source) => [source.id, source]),
    );
    if (sources.size !== bundle.sources.length)
      context.addIssue({ code: 'custom', message: 'DUPLICATE_SOURCE' });
    for (const claim of bundle.claims)
      if (
        !claim.sourceIds.every(
          (id) => sources.get(id)?.role === 'correctness_evidence',
        )
      )
        context.addIssue({
          code: 'custom',
          message: 'CORRECTNESS_EVIDENCE_REQUIRED',
        });
    if (
      bundle.kind === 'question' &&
      !bundle.payload.rubric.requiredClaims.every((claim) =>
        bundle.claims.some((mapping) => mapping.claim === claim),
      )
    )
      context.addIssue({ code: 'custom', message: 'UNMAPPED_RUBRIC_CLAIM' });
    if (
      bundle.kind === 'question' &&
      !bundle.payload.terms.every((term) =>
        bundle.dependencies.some((dependency) => dependency.id === term.termId),
      )
    )
      context.addIssue({ code: 'custom', message: 'TERM_DEPENDENCY_REQUIRED' });
    if (bundle.dependencies.some((dependency) => dependency.id === bundle.id))
      context.addIssue({ code: 'custom', message: 'CYCLIC_DEPENDENCY' });
  });
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyVersion: z.literal(contentPolicy),
    bundles: z.array(bundleSchema).min(1).max(10),
    checksum: digest,
  })
  .strict()
  .refine((manifest) => jsonbTextBytes(manifest) <= 1000000, {
    message: 'MANIFEST_TOO_LARGE',
  });
export type ContentBundle = z.infer<typeof bundleSchema>;
export type ContentManifest = z.infer<typeof manifestSchema>;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function contentDigest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function validateManifest(raw: unknown): ContentManifest {
  const manifest = manifestSchema.parse(raw);
  const { checksum, ...body } = manifest;
  if (contentDigest(body) !== checksum) throw new Error('CHECKSUM_MISMATCH');
  const seen = new Map<string, string>();
  const versions = new Set<string>();
  for (const { digest, ...bundle } of manifest.bundles) {
    if (contentDigest(bundle) !== digest) throw new Error('DIGEST_MISMATCH');
    const version = `${bundle.kind}/${bundle.stableId}/${bundle.version}`;
    if (seen.has(bundle.id) || versions.has(version))
      throw new Error('VERSION_CONFLICT');
    for (const dependency of bundle.dependencies) {
      const local = manifest.bundles.find(
        (entry) => entry.id === dependency.id,
      );
      if (local && seen.get(dependency.id) !== dependency.digest)
        throw new Error('DEPENDENCY_ORDER');
    }
    versions.add(version);
    seen.set(bundle.id, digest);
  }
  return manifest;
}
