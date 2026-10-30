import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  bundleSchema,
  canonicalJson,
  contentDigest,
  validateManifest,
  type ContentBundle,
} from './manifest.ts';
import {
  fixtureReview,
  qualificationIntake,
  qualificationTask,
  sourceSnapshot,
  calibrationIssues,
  sourceReview,
  criticReview,
} from './qualification-contract.ts';
import { gradingTask } from '../contracts/grading.ts';
import { structuredRequest } from './provider.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const text = z.string().min(1).max(2000);
const policyCode = z.enum([
  'SCHEMA_INVALID',
  'DIGEST_MISMATCH',
  'REUSE_RIGHTS_REQUIRED',
  'EVIDENCE_UNVERIFIED',
  'PRIVATE_MATERIAL',
  'DEPENDENCY_MISMATCH',
  'EXECUTION_REQUIRED',
]);
export const evaluationConfiguration = z
  .object({
    protocolVersion: z.literal('release-evaluation-v3'),
    policyVersion: z.literal('content-policy-v2'),
    modelVersion: z.literal('gpt-5.4-mini-2026-03-17'),
    promptVersion: z.literal('qualification-prompts-v3'),
    schemaVersion: z.literal('qualification-schema-v3'),
    fixtureVersion: z.literal('machine-fixtures-v2'),
    graderVersion: z.literal('grader-v3'),
    gradingPromptVersion: z.literal('grade-prompt-v3'),
    reasoningEffort: z.literal('low'),
    gradingSchemaVersion: z.literal('grade-schema-v1'),
    toolchainVersion: z.literal('conceptual-no-execution-v1'),
    inputUsdPerMillion: z.literal(0.75),
    outputUsdPerMillion: z.literal(4.5),
    requestCents: z.literal(10),
    codeDigest: digest,
    mode: z.enum(['live', 'mock']),
    dailyCap: z.number().int().min(0).max(1000),
    monthlyCap: z.number().int().min(0).max(2000),
    batchCap: z.number().int().min(0).max(2000),
    maxRequests: z.number().int().min(1).max(180),
    expiresAt: z.iso.datetime(),
    providerPolicyDigest: digest.nullable(),
    privacyApprovalDigest: digest.nullable(),
    deploymentApprovalDigest: digest.nullable(),
    runAuthorizationDigest: digest.nullable(),
  })
  .strict();
export type EvaluationConfiguration = z.infer<typeof evaluationConfiguration>;

const gradeExpectation = z
  .object({
    kind: z.enum([
      'wrong',
      'partial',
      'borderline_pass',
      'strong',
      'non_answer',
      'uncertain_context',
    ]),
    outcome: z.enum(['scored', 'uncertain']),
    minScore: z.number().int().min(0).max(5).nullable(),
    maxScore: z.number().int().min(0).max(5).nullable(),
    pass: z.boolean().nullable(),
  })
  .strict();
const evaluationCase = z
  .object({
    id,
    stage: z.enum(['policy', 'source', 'fixtures', 'critic', 'grade']),
    candidate: z.unknown(),
    evidence: z.array(sourceSnapshot).max(30),
    dependencies: z.array(bundleSchema).max(20),
    fixtures: fixtureReview.nullable(),
    answer: z.string().min(1).max(12000).nullable(),
    expected: z
      .object({
        policy: z.array(policyCode).max(10),
        accepted: z.boolean().nullable(),
        facets: z
          .object({
            privacy: sourceReview.shape.privacy,
            originality: sourceReview.shape.originality,
            claims: z
              .array(
                sourceReview.shape.claims.element.pick({
                  claim: true,
                  sourceId: true,
                  verdict: true,
                }),
              )
              .max(30),
            fixtures: z
              .array(
                criticReview.shape.fixtures.element.pick({
                  kind: true,
                  verdict: true,
                }),
              )
              .max(5),
            links: z
              .array(
                criticReview.shape.links.element.pick({
                  termId: true,
                  exposure: true,
                  verdict: true,
                }),
              )
              .max(20),
          })
          .strict()
          .nullable(),
        grade: gradeExpectation.nullable(),
        basis: z
          .array(
            z
              .object({
                sourceId: id,
                quote: z.string().min(1).max(5000),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
  })
  .strict();
export type EvaluationCase = z.infer<typeof evaluationCase>;
const datasetSchema = z
  .object({
    id,
    version: z.number().int().positive(),
    preparation: z.literal('reference-derived-before-evaluation-v1'),
    limitations: text,
    cases: z.array(evaluationCase).min(9).max(60),
  })
  .strict();
const packageSchema = z
  .object({
    schemaVersion: z.literal(2),
    id,
    manifest: z.unknown(),
    intakes: z
      .array(qualificationIntake.omit({ batchId: true }))
      .min(1)
      .max(10),
    dataset: datasetSchema,
    attachments: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[a-zA-Z0-9_./-]+\.(txt|rst)$/),
            digest,
            kind: z.enum(['source', 'license', 'notice']),
            sourceUrl: z.url(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    digest,
  })
  .strict();
export type EvaluationPackage = z.infer<typeof packageSchema>;

const codePaths = [
  'lib/content/authoring-contract.ts',
  'lib/content/authoring.ts',
  'lib/content/evaluation-contract.ts',
  'lib/content/model-evaluation.ts',
  'lib/content/qualification-contract.ts',
  'lib/content/qualification.ts',
  'lib/content/provider.ts',
  'lib/content/manifest.ts',
  'lib/contracts/grading.ts',
  'lib/contracts/study.ts',
  'lib/contracts/content.ts',
  'lib/server/ai/grader.ts',
  'lib/server/env.ts',
  'scripts/content-evaluate.ts',
  'scripts/content-author.ts',
  'supabase/migrations/202610300008_calibration_v2.sql',
  'supabase/migrations/202610300009_conceptual_authoring.sql',
  'supabase/migrations/202610300010_evaluation_v3.sql',
  'supabase/migrations/202610290006_qualification.sql',
  'supabase/migrations/202610290007_model_evaluation.sql',
  'package-lock.json',
];
export function evaluationCodeIdentity() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const files = Object.fromEntries(
    codePaths.map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(resolve(root, path)))
        .digest('hex'),
    ]),
  );
  return { files, digest: contentDigest(files) };
}
export function loadPrivatePackage(path: string) {
  const raw = readFileSync(path);
  if (raw.length > 1_000_000) throw new Error('INPUT_TOO_LARGE');
  const parsed = packageSchema.parse(JSON.parse(raw.toString('utf8')));
  const root = realpathSync(dirname(path));
  const sources = new Map<string, string>();
  for (const entry of parsed.attachments) {
    if (entry.path.split('/').includes('..') || entry.path.startsWith('/'))
      throw new Error('ATTACHMENT_INVALID');
    const absolute = realpathSync(resolve(root, entry.path));
    if (!absolute.startsWith(root + sep)) throw new Error('ATTACHMENT_INVALID');
    const bytes = readFileSync(absolute);
    if (
      bytes.length > 1_000_000 ||
      createHash('sha256').update(bytes).digest('hex') !== entry.digest
    )
      throw new Error('ATTACHMENT_INVALID');
    if (entry.kind === 'source')
      sources.set(entry.sourceUrl, bytes.toString('utf8'));
  }
  if (
    !parsed.attachments.some((a) => a.kind === 'license') ||
    !parsed.attachments.some((a) => a.kind === 'notice')
  )
    throw new Error('RIGHTS_RECORD_REQUIRED');
  const evidence = [
    ...parsed.intakes.flatMap((i) => i.evidence),
    ...parsed.dataset.cases
      .filter((c) => c.stage !== 'policy')
      .flatMap((c) => c.evidence),
  ];
  if (evidence.some((e) => !sources.get(e.url)?.includes(e.text)))
    throw new Error('EVIDENCE_ATTACHMENT_REQUIRED');
  return parsed;
}

export function evidenceIssues(
  raw: unknown,
  evidence: EvaluationCase['evidence'],
  dependencies: ContentBundle[],
) {
  const parsed = bundleSchema.safeParse(raw);
  if (!parsed.success)
    return [
      parsed.error.issues.some((i) => i.message === 'REUSE_RIGHTS_REQUIRED')
        ? 'REUSE_RIGHTS_REQUIRED'
        : 'SCHEMA_INVALID',
    ];
  const { digest: claimed, ...body } = parsed.data;
  const issues: string[] = [];
  if (contentDigest(body) !== claimed) issues.push('DIGEST_MISMATCH');
  if (
    /(-----BEGIN[^-]*PRIVATE KEY|sk-[a-z0-9]{20,}|AKIA[A-Z0-9]{16}|password\s*[:=])/i.test(
      JSON.stringify([raw, evidence]),
    )
  )
    issues.push('PRIVATE_MATERIAL');
  const sources = parsed.data.sources.filter(
    (s) => s.role === 'correctness_evidence',
  );
  if (
    new Set(evidence.map((e) => e.sourceId)).size !== evidence.length ||
    evidence.length !== sources.length ||
    sources.some((s) => {
      const e = evidence.find((e) => e.sourceId === s.id);
      return (
        !e ||
        e.url !== s.url ||
        e.edition !== s.edition ||
        e.locator !== s.locator ||
        createHash('sha256').update(e.text).digest('hex') !== e.digest ||
        (s.useMode === 'permitted_reuse' && s.payloadDigest !== e.digest)
      );
    })
  )
    issues.push('EVIDENCE_UNVERIFIED');
  if (
    parsed.data.dependencies.length !== dependencies.length ||
    parsed.data.dependencies.some(
      (d) => !dependencies.some((b) => b.id === d.id && b.digest === d.digest),
    ) ||
    dependencies.some((b) => {
      const { digest, ...body } = b;
      return contentDigest(body) !== digest;
    })
  )
    issues.push('DEPENDENCY_MISMATCH');
  if (
    parsed.data.kind === 'question' &&
    parsed.data.payload.blocks.some((b) => b.type === 'code')
  )
    issues.push('EXECUTION_REQUIRED');
  return issues.sort();
}

function compileCase(entry: EvaluationCase) {
  const issues = evidenceIssues(
    entry.candidate,
    entry.evidence,
    entry.dependencies,
  );
  const expected = entry.expected;
  const facets = expected.facets;
  if (entry.stage === 'source' || entry.stage === 'critic') {
    const candidate = bundleSchema.parse(entry.candidate);
    if (!facets) throw new Error('CASE_FACETS_INVALID');
    const links = candidate.kind === 'question' ? candidate.payload.terms : [];
    const fixtures =
      candidate.kind === 'question' ? (entry.fixtures?.cases ?? []) : [];
    const complete =
      entry.stage === 'source'
        ? !facets.fixtures.length &&
          !facets.links.length &&
          facets.claims.length === candidate.claims.length &&
          new Set(facets.claims.map((c) => c.claim)).size ===
            facets.claims.length &&
          facets.claims.every((f) =>
            candidate.claims.some(
              (c) => c.claim === f.claim && c.sourceIds.includes(f.sourceId),
            ),
          )
        : !facets.claims.length &&
          facets.fixtures.length === fixtures.length &&
          new Set(facets.fixtures.map((f) => f.kind)).size ===
            facets.fixtures.length &&
          facets.fixtures.every((f) =>
            fixtures.some((c) => c.kind === f.kind),
          ) &&
          facets.links.length === links.length &&
          new Set(facets.links.map((l) => l.termId)).size ===
            facets.links.length &&
          facets.links.every((l) =>
            links.some(
              (c) => c.termId === l.termId && c.exposure === l.exposure,
            ),
          );
    const safe =
      facets.privacy === 'public' &&
      facets.originality === 'original' &&
      facets.claims.every((c) => c.verdict === 'supported') &&
      facets.fixtures.every((f) => f.verdict === 'supported') &&
      facets.links.every(
        (l) =>
          l.verdict ===
          (l.exposure === 'pre_attempt_safe' ? 'safe' : 'post_grade_only'),
      );
    if (!complete || safe !== expected.accepted)
      throw new Error('CASE_FACETS_INVALID');
  } else if (facets !== null) throw new Error('CASE_FACETS_INVALID');
  if (entry.stage === 'policy') {
    if (
      !expected.policy.length ||
      expected.accepted !== null ||
      expected.grade !== null ||
      expected.policy.join() !== [...expected.policy].sort().join()
    )
      throw new Error('CASE_EXPECTATION_INVALID');
    return { ...entry, policyIssues: issues, requests: null };
  }
  if (
    issues.length ||
    expected.policy.length ||
    !expected.basis.length ||
    expected.basis.some(
      (b) =>
        !entry.evidence.some(
          (e) => e.sourceId === b.sourceId && e.text.includes(b.quote),
        ),
    )
  )
    throw new Error('CASE_EVIDENCE_INVALID');
  const candidate = bundleSchema.parse(entry.candidate);
  if (calibrationIssues(candidate).length)
    throw new Error('CANDIDATE_INPUT_INVALID');
  const build = (repair: boolean) => {
    if (entry.stage === 'grade') {
      if (
        candidate.kind !== 'question' ||
        !entry.answer ||
        !expected.grade ||
        expected.accepted !== null
      )
        throw new Error('CASE_EXPECTATION_INVALID');
      const g = expected.grade;
      if (
        g.kind === 'uncertain_context'
          ? g.outcome !== 'uncertain' ||
            g.minScore !== null ||
            g.maxScore !== null ||
            g.pass !== null
          : g.outcome !== 'scored' ||
            g.minScore === null ||
            g.maxScore === null ||
            g.minScore > g.maxScore ||
            g.pass !== !['wrong', 'partial', 'non_answer'].includes(g.kind) ||
            (g.pass
              ? g.minScore < candidate.payload.rubric.passScore
              : g.maxScore >= candidate.payload.rubric.passScore)
      )
        throw new Error('CASE_EXPECTATION_INVALID');
      const task = gradingTask(
        {
          question: candidate.payload.blocks,
          assumptions: candidate.payload.assumptions,
          rubric: {
            version: candidate.payload.rubric.version,
            pass_score: candidate.payload.rubric.passScore,
            required_claims: candidate.payload.rubric.requiredClaims,
            reference_answer: candidate.payload.rubric.referenceAnswer,
          },
          learnerAnswer: entry.answer,
        },
        repair,
      );
      return structuredRequest(
        task,
        'gpt-5.4-mini-2026-03-17',
        'technical_grade',
      );
    }
    if (
      expected.accepted === null ||
      expected.grade !== null ||
      entry.answer !== null
    )
      throw new Error('CASE_EXPECTATION_INVALID');
    const task = qualificationTask(
      {
        stage: entry.stage,
        candidate,
        evidence: entry.evidence,
        dependencies: entry.dependencies,
        artifacts: {
          fixtures: entry.fixtures,
          execution: {
            status: 'not_applicable',
            reason:
              'Reference-derived conceptual holdout; no code or executable claim.',
          },
        },
      },
      repair,
    );
    return structuredRequest(
      task,
      'gpt-5.4-mini-2026-03-17',
      'content_qualification',
    );
  };
  return {
    ...entry,
    policyIssues: [],
    requests: { original: build(false), repair: build(true) },
  };
}

export function compileEvaluation(raw: unknown, rawConfiguration: unknown) {
  const input = packageSchema.parse(raw);
  const { digest: claimed, ...body } = input;
  if (contentDigest(body) !== claimed)
    throw new Error('PACKAGE_DIGEST_MISMATCH');
  const configuration = evaluationConfiguration.parse(rawConfiguration);
  const code = evaluationCodeIdentity();
  if (configuration.codeDigest !== code.digest)
    throw new Error('CODE_MISMATCH');
  const manifest = validateManifest(input.manifest);
  if (
    input.intakes.length !== manifest.bundles.length ||
    new Set(input.intakes.map((i) => i.candidateId)).size !==
      input.intakes.length ||
    input.intakes.some((i) => {
      const candidate = manifest.bundles.find((b) => b.id === i.candidateId);
      return (
        !candidate ||
        evidenceIssues(
          candidate,
          i.evidence,
          candidate.dependencies
            .map((d) => manifest.bundles.find((b) => b.id === d.id)!)
            .filter(Boolean),
        ).length > 0 ||
        calibrationIssues(candidate).length > 0
      );
    })
  )
    throw new Error('CANDIDATE_INPUT_INVALID');
  const cases = input.dataset.cases.map(compileCase);
  if (
    new Set(cases.map((c) => c.id)).size !== cases.length ||
    cases.some((c) => {
      const candidate = bundleSchema.safeParse(c.candidate);
      return (
        candidate.success &&
        [candidate.data, ...c.dependencies].some((h) =>
          manifest.bundles.some(
            (b) =>
              b.id === h.id || (b.kind === h.kind && b.stableId === h.stableId),
          ),
        )
      );
    })
  )
    throw new Error('HOLDOUT_IDENTITY_INVALID');
  if (
    !['source', 'fixtures', 'critic', 'grade', 'policy'].every((stage) =>
      cases.some((c) => c.stage === stage),
    ) ||
    ![
      'wrong',
      'partial',
      'borderline_pass',
      'strong',
      'non_answer',
      'uncertain_context',
    ].every((kind) => cases.some((c) => c.expected.grade?.kind === kind)) ||
    !cases.some((c) => c.stage === 'source' && c.expected.accepted === false) ||
    !cases.some((c) => c.stage === 'critic' && c.expected.accepted === false) ||
    !cases.some((c) => c.expected.policy.includes('REUSE_RIGHTS_REQUIRED'))
  )
    throw new Error('COVERAGE_INCOMPLETE');
  const datasetDigest = contentDigest(input.dataset);
  const configurationDigest = contentDigest(configuration);
  const identity = contentDigest({
    packageDigest: claimed,
    datasetDigest,
    codeDigest: code.digest,
    protocolVersion: configuration.protocolVersion,
    modelVersion: configuration.modelVersion,
  });
  return {
    identity,
    packageDigest: claimed,
    datasetDigest,
    configurationDigest,
    configuration,
    code,
    cases,
    package: input,
  };
}
export type EvaluationPlan = ReturnType<typeof compileEvaluation>;
export function validateEvaluationPlan(raw: EvaluationPlan) {
  if (
    contentDigest(compileEvaluation(raw.package, raw.configuration)) !==
    contentDigest(raw)
  )
    throw new Error('REQUEST_MISMATCH');
  return raw;
}

export function offlineEvaluation(raw: unknown, configuration: unknown) {
  const plan = compileEvaluation(raw, configuration);
  return {
    schemaVersion: 'evaluation-report-v3',
    identity: plan.identity,
    packageDigest: plan.packageDigest,
    datasetDigest: plan.datasetDigest,
    configurationDigest: plan.configurationDigest,
    code: plan.code,
    versions: plan.configuration,
    status: 'not_evaluated',
    dispatchBlockers: [
      ...(!plan.configuration.dailyCap ||
      !plan.configuration.monthlyCap ||
      !plan.configuration.batchCap
        ? ['ZERO_BUDGET']
        : []),
      ...([
        'providerPolicyDigest',
        'privacyApprovalDigest',
        'deploymentApprovalDigest',
        'runAuthorizationDigest',
      ].some((key) => !plan.configuration[key as keyof EvaluationConfiguration])
        ? ['AUTHORIZATION_REQUIRED']
        : []),
    ],
    deterministicPolicyStatus: plan.cases.some(
      (c) =>
        c.stage === 'policy' &&
        c.policyIssues.join() !== c.expected.policy.join(),
    )
      ? 'mismatch'
      : 'matched',
    approvalAuthority: 'none',
    requestsUsed: 0,
    reservedCents: 0,
    cases: plan.cases.map((c) => ({
      id: c.id,
      status:
        c.stage === 'policy' ? 'deterministic_policy_only' : 'not_evaluated',
      reasons: c.policyIssues,
      expectationMatched:
        c.stage === 'policy'
          ? c.policyIssues.join() === c.expected.policy.join()
          : null,
    })),
  };
}
export function persistPrivateReport(directory: string, report: unknown) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bytes = canonicalJson(report) + '\n';
  const digest = contentDigest(report);
  const path = resolve(directory, `${digest}.json`);
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EEXIST' ||
      readFileSync(path, 'utf8') !== bytes
    )
      throw new Error('REPORT_CONFLICT');
  }
  return { digest };
}
