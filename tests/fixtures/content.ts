import { randomUUID } from 'node:crypto';
import {
  contentDigest,
  type ContentBundle,
  type ContentManifest,
} from '@/lib/content/manifest';
import { contentPolicy } from '@/lib/contracts/content';

type QuestionBundle = Extract<ContentBundle, { kind: 'question' }>;
type TermBundle = Extract<ContentBundle, { kind: 'term' }>;
const provenance = () => ({
  sources: [
    {
      id: 'synthetic-reference',
      role: 'correctness_evidence' as const,
      url: 'https://standards.example.test/synthetic',
      locator: 'Synthetic fixture section 1',
      edition: 'synthetic-v1',
      accessedAt: '2026-10-28T00:00:00Z',
      intendedUse: 'Isolated conformance testing; not curriculum evidence.',
      useMode: 'reference_only' as const,
      rightsBasis: null,
      attribution: null,
      payloadDigest: null,
    },
  ],
  claims: [
    {
      claim: 'Synthetic fixture claim.',
      sourceIds: ['synthetic-reference'],
    },
  ],
});

export function questionBundle(
  stableId: string,
  payload: Partial<QuestionBundle['payload']> = {},
  overrides: Partial<Omit<QuestionBundle, 'payload' | 'digest'>> = {},
): QuestionBundle {
  const body = {
    id: randomUUID(),
    kind: 'question' as const,
    stableId,
    version: 1,
    parentId: null,
    origin: 'generation' as const,
    ...provenance(),
    dependencies: [],
    payload: {
      title: `Synthetic ${stableId}`,
      domain: 'cpp' as const,
      category: 'Explain' as const,
      skillId: 'cpp.lifetime',
      skill: 'Synthetic conformance',
      secondarySkills: [],
      assumptions: 'A synthetic non-curriculum demonstration.',
      prerequisites: [],
      difficulty: 2,
      blocks: [
        {
          type: 'text' as const,
          text: 'Synthetic exercise: describe the label on a blue test token. This is not curriculum content.',
        },
      ],
      promptVersion: 'synthetic-v1',
      rubric: {
        version: 'synthetic-rubric-v1',
        passScore: 4,
        requiredClaims: ['Synthetic fixture claim.'],
        referenceAnswer:
          'Synthetic demonstration only; no curriculum answer key. Score 5: A fully correct answer earns 5 without extra prose.',
      },
      terms: [],
      ...payload,
    },
    ...overrides,
  };
  return { ...body, digest: contentDigest(body) };
}
export function termBundle(stableId: string): TermBundle {
  const body = {
    id: randomUUID(),
    kind: 'term' as const,
    stableId,
    version: 1,
    parentId: null,
    origin: 'generation' as const,
    ...provenance(),
    dependencies: [],
    payload: {
      title: `Synthetic ${stableId}`,
      domain: 'cpp' as const,
      definition: 'A test token is a neutral synthetic marker.',
      intuition: 'Think of a label used only to demonstrate a control.',
      example: 'The label A identifies a synthetic marker, not a solution.',
    },
  };
  return { ...body, digest: contentDigest(body) };
}
export function manifestFor(bundles: ContentBundle[]): ContentManifest {
  const body: Omit<ContentManifest, 'checksum'> = {
    schemaVersion: 1 as const,
    policyVersion: contentPolicy,
    bundles,
  };
  return { ...body, checksum: contentDigest(body) };
}
export function syntheticEvidence(bundle: ContentBundle) {
  return {
    synthetic: true,
    bundleDigest: bundle.digest,
    policyVersion: contentPolicy,
    modelVersion: 'gpt-5.4-mini-2026-03-17',
    promptVersion: 'qualification-prompts-v2',
    schemaVersion: 'qualification-schema-v2',
    modelEvaluationProtocolVersion: 'release-evaluation-v2',
    modelEvaluationDigest: '1'.repeat(64),
    graderVersion: 'grader-v2',
    gradingPromptVersion: 'grade-prompt-v2',
    gradingSchemaVersion: 'grade-schema-v1',
    toolchainVersion: 'synthetic-no-execution',
    fixtureVersion: 'machine-fixtures-v2',
    checks: Object.fromEntries(
      [
        'schema',
        'rights',
        'claims',
        'duplicates',
        'critic',
        'fixtures',
        'grader',
        'links',
        'privacy',
      ].map((name) => [name, 'pass']),
    ),
    criticObjections: [],
    authorTask: 'synthetic-author',
    criticTask: 'synthetic-critic',
    similarity: { version: 'jaccard-v1', threshold: 0.85, result: 'clear' },
    dependencies: bundle.dependencies,
    sourcesDigest: contentDigest(bundle.sources),
    execution: {
      status: 'not_applicable',
      reason: 'Synthetic non-executable conformance fixture.',
    },
    requestsUsed: 1,
    lineageRequestsUsed: 1,
    fixtureKinds: [
      'wrong',
      'partial',
      'borderline_pass',
      'strong',
      'non_answer',
    ],
    fixtureAuthor: 'machine',
    graderReversals: 0,
    outOfRange: 0,
  };
}
