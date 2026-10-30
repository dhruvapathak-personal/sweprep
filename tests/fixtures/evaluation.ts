import { createHash, randomUUID } from 'node:crypto';
import { contentDigest, type ContentBundle } from '@/lib/content/manifest';
import {
  evaluationCodeIdentity,
  type EvaluationCase,
  type EvaluationConfiguration,
  type EvaluationPackage,
} from '@/lib/content/evaluation-contract';
import { manifestFor, questionBundle, termBundle } from './content';

export function rehash<T extends { digest: string }>(value: T): T {
  const body = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'digest'),
  );
  return { ...value, digest: contentDigest(body) };
}
export function snapshots(bundle: ContentBundle): EvaluationCase['evidence'] {
  return bundle.sources
    .filter((s) => s.role === 'correctness_evidence')
    .map((s) => {
      const text = 'Synthetic fixture claim.';
      return {
        sourceId: s.id,
        url: s.url,
        edition: s.edition,
        locator: s.locator,
        authority: 'standard',
        permissionBasis:
          'The synthetic source is authored only for conformance tests.',
        provenance:
          'Synthetic non-curriculum data; no external evidence or live release result.',
        text,
        digest: createHash('sha256').update(text).digest('hex'),
      };
    });
}
export function evaluationConfig(
  overrides: Partial<EvaluationConfiguration> = {},
): EvaluationConfiguration {
  return {
    protocolVersion: 'release-evaluation-v3',
    policyVersion: 'content-policy-v2',
    modelVersion: 'gpt-5.4-mini-2026-03-17',
    promptVersion: 'qualification-prompts-v3',
    schemaVersion: 'qualification-schema-v3',
    fixtureVersion: 'machine-fixtures-v2',
    graderVersion: 'grader-v3',
    gradingPromptVersion: 'grade-prompt-v3',
    reasoningEffort: 'low',
    gradingSchemaVersion: 'grade-schema-v1',
    toolchainVersion: 'conceptual-no-execution-v1',
    inputUsdPerMillion: 0.75,
    outputUsdPerMillion: 4.5,
    requestCents: 10,
    codeDigest: evaluationCodeIdentity().digest,
    mode: 'mock',
    dailyCap: 100,
    monthlyCap: 2000,
    batchCap: 2000,
    maxRequests: 60,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    providerPolicyDigest: '1'.repeat(64),
    privacyApprovalDigest: '2'.repeat(64),
    deploymentApprovalDigest: '3'.repeat(64),
    runAuthorizationDigest: '4'.repeat(64),
    ...overrides,
  };
}
export function syntheticPackage(): EvaluationPackage {
  const staged = termBundle(`synthetic-staged-${randomUUID()}`);
  const candidate = questionBundle(`synthetic-holdout-${randomUUID()}`);
  const evidence = snapshots(candidate);
  const basis = [
    {
      claim: candidate.claims[0].claim,
      sourceId: evidence[0].sourceId,
      quote: evidence[0].text,
    },
  ];
  const kinds = [
    'wrong',
    'partial',
    'borderline_pass',
    'strong',
    'non_answer',
  ] as const;
  const fixtures = {
    cases: kinds.map((kind, index) => ({
      kind,
      answer: `Synthetic independent answer ${kind}`,
      expected: 'scored' as const,
      minScore: [0, 1, 4, 4, 0][index],
      maxScore: [0, 2, 4, 5, 0][index],
      expectedPass: index === 2 || index === 3,
      reason:
        'The independently fixed synthetic expectation tests conformance, not curriculum quality.',
      basis,
    })),
  };
  const entry = (
    id: string,
    stage: EvaluationCase['stage'],
    accepted: boolean | null,
  ): EvaluationCase => ({
    id,
    stage,
    candidate,
    evidence,
    dependencies: [],
    fixtures: stage === 'critic' ? fixtures : null,
    answer: null,
    expected: {
      policy: [],
      accepted,
      facets:
        stage === 'source' || stage === 'critic'
          ? {
              privacy: 'public',
              originality: 'original',
              claims:
                stage === 'source'
                  ? candidate.claims.map((c) => ({
                      claim: c.claim,
                      sourceId: c.sourceIds[0],
                      verdict: 'supported',
                    }))
                  : [],
              fixtures:
                stage === 'critic'
                  ? kinds.map((kind) => ({ kind, verdict: 'supported' }))
                  : [],
              links: [],
            }
          : null,
      grade: null,
      basis: basis.map(({ sourceId, quote }) => ({ sourceId, quote })),
    },
  });
  const negative = structuredClone(candidate);
  negative.id = randomUUID();
  negative.stableId += '-unsupported';
  negative.claims[0].claim = 'A deliberately unsupported synthetic assertion.';
  negative.payload.rubric.requiredClaims = [negative.claims[0].claim];
  negative.payload.rubric.referenceAnswer =
    negative.claims[0].claim + ' Score 5: A fully correct answer earns 5.';
  const spoiler = termBundle(`synthetic-spoiler-${randomUUID()}`);
  spoiler.payload.definition = candidate.payload.rubric.requiredClaims[0];
  const term = rehash(spoiler);
  const linked = questionBundle(
    `synthetic-linked-${randomUUID()}`,
    {
      terms: [
        { termId: term.id, exposure: 'pre_attempt_safe', required: false },
      ],
    },
    { dependencies: [{ id: term.id, digest: term.digest }] },
  );
  const rights = structuredClone(candidate);
  Object.assign(rights.sources[0], {
    useMode: 'permitted_reuse',
    rightsBasis: null,
  });
  const cases: EvaluationCase[] = [
    entry('source-supported', 'source', true),
    {
      ...entry('source-unsupported', 'source', false),
      candidate: rehash(negative),
      expected: {
        ...entry('source-unsupported', 'source', false).expected,
        facets: {
          privacy: 'public',
          originality: 'original',
          fixtures: [],
          links: [],
          claims: [
            {
              claim: negative.claims[0].claim,
              sourceId: evidence[0].sourceId,
              verdict: 'unsupported',
            },
          ],
        },
      },
    },
    entry('fixtures-independent', 'fixtures', true),
    entry('critic-clear', 'critic', true),
    {
      ...entry('critic-spoiler', 'critic', false),
      candidate: linked,
      dependencies: [term],
      expected: {
        ...entry('critic-spoiler', 'critic', false).expected,
        facets: {
          privacy: 'public',
          originality: 'original',
          claims: [],
          fixtures: kinds.map((kind) => ({ kind, verdict: 'supported' })),
          links: [
            {
              termId: term.id,
              exposure: 'pre_attempt_safe',
              verdict: 'spoiler_or_uncertain',
            },
          ],
        },
      },
    },
    ...fixtures.cases.map((f) => ({
      ...entry(`grade-${f.kind}`, 'grade', null),
      answer: f.answer,
      expected: {
        policy: [],
        accepted: null,
        facets: null,
        grade: {
          kind: f.kind,
          outcome: f.expected,
          minScore: f.minScore,
          maxScore: f.maxScore,
          pass: f.expectedPass,
        },
        basis: [{ sourceId: basis[0].sourceId, quote: basis[0].quote }],
      },
    })),
    {
      ...entry('grade-uncertain-context', 'grade', null),
      candidate: rehash({
        ...candidate,
        id: randomUUID(),
        stableId: candidate.stableId + '-context-control',
        payload: {
          ...candidate.payload,
          assumptions:
            'Two equally authoritative labels conflict: the marker is amber and the marker is blue. No precedence rule is supplied.',
        },
      }),
      answer: 'The marker is amber.',
      expected: {
        policy: [],
        accepted: null,
        facets: null,
        grade: {
          kind: 'uncertain_context',
          outcome: 'uncertain',
          minScore: null,
          maxScore: null,
          pass: null,
        },
        basis: [{ sourceId: basis[0].sourceId, quote: basis[0].quote }],
      },
    },
    {
      ...entry('policy-rights', 'policy', null),
      candidate: rights,
      expected: {
        policy: ['REUSE_RIGHTS_REQUIRED'],
        accepted: null,
        facets: null,
        grade: null,
        basis: [],
      },
    },
  ];
  const body = {
    schemaVersion: 2 as const,
    id: `synthetic-${randomUUID()}`,
    manifest: manifestFor([staged]),
    intakes: [{ candidateId: staged.id, evidence: snapshots(staged) }],
    dataset: {
      id: `synthetic-independent-${staged.id}`,
      version: 1,
      preparation: 'reference-derived-before-evaluation-v1' as const,
      limitations:
        'Synthetic conformance only. Not genuine curriculum, human gold or live model evidence.',
      cases,
    },
    attachments: [
      {
        path: 'reference.txt',
        digest: createHash('sha256')
          .update('Synthetic fixture claim.')
          .digest('hex'),
        kind: 'source' as const,
        sourceUrl: 'https://standards.example.test/synthetic',
      },
      {
        path: 'license.txt',
        digest: createHash('sha256')
          .update('Synthetic license.\n')
          .digest('hex'),
        kind: 'license' as const,
        sourceUrl: 'https://example.test/license',
      },
      {
        path: 'notice.txt',
        digest: createHash('sha256')
          .update('Synthetic notice.\n')
          .digest('hex'),
        kind: 'notice' as const,
        sourceUrl: 'https://example.test/notice',
      },
    ],
  };
  return { ...body, digest: contentDigest(body) };
}
export function modelOutput(entry: EvaluationCase): unknown {
  const candidate = entry.candidate as ContentBundle;
  const basis = candidate.claims.map((c) => ({
    claim: c.claim,
    sourceId: c.sourceIds[0],
    quote: entry.evidence[0].text,
  }));
  if (entry.stage === 'source')
    return {
      independentAnswer: 'Independent synthetic source solution.',
      privacy: 'public',
      originality: 'original',
      issues: [],
      claims: basis.map((b) => ({
        ...b,
        verdict: entry.expected.accepted ? 'supported' : 'unsupported',
        reason: 'Synthetic source comparison.',
      })),
      executionRequired: false,
      executionPlan: [],
    };
  if (entry.stage === 'fixtures')
    return syntheticPackage().dataset.cases.find((c) => c.stage === 'critic')!
      .fixtures;
  if (entry.stage === 'critic')
    return {
      independentAnswer: 'Independent synthetic critic solution.',
      privacy: 'public',
      originality: 'original',
      objections: [],
      proofLimits: [
        'A conformance case cannot establish curriculum correctness.',
      ],
      fixtures: entry.fixtures!.cases.map((f) => ({
        kind: f.kind,
        verdict: 'supported',
        reason: 'Independent synthetic check.',
      })),
      links:
        candidate.kind === 'question'
          ? candidate.payload.terms.map((t) => ({
              termId: t.termId,
              exposure: t.exposure,
              verdict: entry.expected.accepted
                ? 'safe'
                : 'spoiler_or_uncertain',
              reason: 'Synthetic contextual disclosure check.',
            }))
          : [],
    };
  const expected = entry.expected.grade!;
  return {
    assessment:
      expected.outcome === 'uncertain'
        ? {
            outcome: 'uncertain',
            reason: 'The synthetic response has no justified score.',
          }
        : {
            outcome: 'scored',
            score: expected.minScore,
            criticalClaimsMet: expected.pass,
            correctClaims: ['Synthetic claim.'],
            missingClaims: [],
            incorrectClaims: [],
            idealAnswer: 'Synthetic ideal answer.',
            explanation: 'Synthetic expectation comparison.',
          },
  };
}
