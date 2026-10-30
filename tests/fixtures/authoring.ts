import { createHash, randomUUID } from 'node:crypto';
import { evaluationCodeIdentity } from '@/lib/content/evaluation-contract';
import type { ContentBundle } from '@/lib/content/manifest';
import type { AuthoringSpecification } from '@/lib/content/authoring-contract';

export function authoringSpec(
  bundle: ContentBundle,
  batchId: string = randomUUID(),
): AuthoringSpecification {
  return {
    id: randomUUID(),
    batchId,
    revisionOf: null,
    kind: bundle.kind,
    stableId: bundle.stableId,
    coverage: `Synthetic coverage ${bundle.stableId}`,
    domain: bundle.payload.domain,
    skillId: bundle.kind === 'question' ? bundle.payload.skillId : null,
    sources: bundle.sources,
    dependencies: [],
    evidence: bundle.sources.map((s) => {
      const text = bundle.claims.map((c) => c.claim).join('\n');
      return {
        sourceId: s.id,
        url: s.url,
        edition: s.edition,
        locator: s.locator,
        authority: 'official_documentation' as const,
        permissionBasis: 'Synthetic source authored for isolated tests.',
        provenance:
          'Entire synthetic source supplied locally, not curriculum material.',
        text,
        digest: createHash('sha256').update(text).digest('hex'),
      };
    }),
    authorization: {
      promptVersion: 'conceptual-authoring-prompts-v2',
      schemaVersion: 'conceptual-authoring-schema-v1',
      codeDigest: evaluationCodeIdentity().digest,
      runAuthorizationDigest: 'a'.repeat(64),
    },
  };
}
