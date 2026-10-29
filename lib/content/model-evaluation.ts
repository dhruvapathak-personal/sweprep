import { spawnSync } from 'node:child_process';
import OpenAI from 'openai';
import { z } from 'zod';
import { contentDigest } from './manifest.ts';
import { providerBaseUrl } from './provider.ts';
import { gradingOutput } from '../contracts/grading.ts';
import {
  qualificationTask,
  validateQualificationTask,
} from './qualification-contract.ts';
import {
  validateEvaluationPlan,
  type EvaluationPlan,
} from './evaluation-contract.ts';

export function evaluationSql(operation: string, args: unknown[]) {
  const signatures: Record<string, string[]> = {
    open: ['jsonb'],
    claim: ['uuid'],
    reserve: ['uuid', 'uuid', 'boolean'],
    complete: ['uuid', 'uuid', 'uuid', 'jsonb', 'text', 'integer', 'jsonb'],
    finish: ['uuid', 'uuid', 'text'],
    yield: ['uuid', 'uuid', 'text'],
    export: ['uuid'],
  };
  const signature = signatures[operation];
  if (!signature || signature.length !== args.length || !process.env.PGSERVICE)
    throw new Error('EVALUATION_DATABASE_REQUIRED');
  const literals = args.map((value, index) =>
    value === null
      ? 'null'
      : `'${(signature[index] === 'jsonb' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'::${signature[index]}`,
  );
  const result = spawnSync(
    'psql',
    ['-X', '-w', '-q', '-v', 'ON_ERROR_STOP=1', '-At'],
    {
      input: `select to_jsonb(private.evaluation_${operation}(${literals.join(',')}));\n`,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 12_000_000,
    },
  );
  if (result.status !== 0) {
    const code = [
      'STALE_LEASE',
      'REQUEST_LIMIT',
      'BUDGET_EXCEEDED',
      'EVALUATION_DISABLED',
      'EVALUATION_REVISION_REQUIRED',
      'EVALUATION_INPUT_INVALID',
    ].find((code) => result.stderr?.includes(`ERROR:  ${code}`));
    throw new Error(code ?? 'EVALUATION_DATABASE_FAILED');
  }
  return result.stdout.trim()
    ? (JSON.parse(result.stdout.trim()) as unknown)
    : null;
}
const workSchema = z.object({
  id: z.uuid(),
  state: z.enum(['queued', 'running', 'completed']),
  lease: z.uuid().nullable(),
  reason: z.string().nullable(),
  requestsUsed: z.number().int().nonnegative(),
  costCents: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  plan: z.custom<EvaluationPlan>(),
  case: z.custom<EvaluationPlan['cases'][number]>().nullable(),
});
type Work = z.infer<typeof workSchema>;
function assertDispatch(work?: Work) {
  if (
    [
      'MODEL_EVALUATION_ENABLED',
      'MODEL_EVALUATION_PROVIDER_POLICY_APPROVED',
      'MODEL_EVALUATION_PRIVACY_APPROVED',
      'MODEL_EVALUATION_DEPLOYMENT_APPROVED',
      'MODEL_EVALUATION_RUN_AUTHORIZED',
    ].some((key) => process.env[key] !== 'true') ||
    !process.env.OPENAI_API_KEY
  )
    throw new Error('EVALUATION_DISABLED');
  if (!work) return;
  const plan = validateEvaluationPlan(work.plan);
  const config = plan.configuration;
  if (
    plan.cases.some(
      (c) =>
        c.stage === 'policy' &&
        c.policyIssues.join() !== c.expected.policy.join(),
    )
  )
    throw new Error('EVALUATION_DISABLED');
  const gates: Record<string, string | null> = {
    MODEL_EVALUATION_CONFIGURATION_DIGEST: plan.configurationDigest,
    MODEL_EVALUATION_PACKAGE_DIGEST: plan.packageDigest,
    MODEL_EVALUATION_PROVIDER_POLICY_DIGEST: config.providerPolicyDigest,
    MODEL_EVALUATION_PRIVACY_APPROVAL_DIGEST: config.privacyApprovalDigest,
    MODEL_EVALUATION_DEPLOYMENT_APPROVAL_DIGEST:
      config.deploymentApprovalDigest,
    MODEL_EVALUATION_RUN_AUTHORIZATION_DIGEST: config.runAuthorizationDigest,
  };
  if (
    Date.parse(config.expiresAt) <= Date.now() ||
    !config.dailyCap ||
    !config.monthlyCap ||
    !config.batchCap ||
    Object.entries(gates).some(
      ([key, value]) => !value || process.env[key] !== value,
    ) ||
    (work.case !== null &&
      !plan.cases.some((c) => contentDigest(c) === contentDigest(work.case)))
  )
    throw new Error('EVALUATION_DISABLED');
}
function summary(work: Work) {
  return {
    id: work.id,
    state: work.state,
    reason: work.reason,
    requestsUsed: work.requestsUsed,
    costCents: work.costCents,
  };
}
export async function evaluateOnce(runId: string) {
  assertDispatch();
  const claimed = evaluationSql('claim', [z.uuid().parse(runId)]);
  if (!claimed) return null;
  let work = workSchema.parse(claimed);
  while (work.state === 'running') {
    try {
      assertDispatch(work);
    } catch {
      return summary(
        workSchema.parse(
          evaluationSql('yield', [work.id, work.lease, 'EVALUATION_DISABLED']),
        ),
      );
    }
    if (!work.case)
      return summary(
        workSchema.parse(evaluationSql('finish', [work.id, work.lease, null])),
      );
    if (work.requestsUsed >= work.plan.configuration.maxRequests)
      return summary(
        workSchema.parse(
          evaluationSql('finish', [work.id, work.lease, 'REQUEST_LIMIT']),
        ),
      );
    const entry = work.case;
    if (!entry.requests) throw new Error('REQUEST_MISMATCH');
    const repair = work.invalid > 0;
    let request: unknown;
    try {
      request = evaluationSql('reserve', [work.id, work.lease, repair]);
    } catch (error) {
      if (
        error instanceof Error &&
        ['BUDGET_EXCEEDED', 'EVALUATION_DISABLED'].includes(error.message)
      )
        return summary(
          workSchema.parse(
            evaluationSql('yield', [work.id, work.lease, error.message]),
          ),
        );
      throw error;
    }
    let output: unknown = null;
    let error: string | null = null;
    let cents: number | null = null;
    let usage: unknown = null;
    try {
      const client = new OpenAI({
        baseURL: providerBaseUrl,
        apiKey: process.env.OPENAI_API_KEY,
        maxRetries: 0,
        timeout: 30000,
      });
      const response = await client.responses.create(
        entry.requests[repair ? 'repair' : 'original'],
      );
      const tokens = z
        .object({
          input_tokens: z.number().int().min(0).max(1000000),
          output_tokens: z.number().int().min(0).max(3000),
        })
        .safeParse(response.usage);
      if (tokens.success) {
        usage = {
          inputTokens: tokens.data.input_tokens,
          outputTokens: tokens.data.output_tokens,
        };
        const charged = Math.ceil(
          (tokens.data.input_tokens * 0.75 + tokens.data.output_tokens * 4.5) /
            10000,
        );
        if (charged <= 10) cents = charged;
      }
      try {
        if (
          typeof response.output_text === 'string' &&
          Buffer.byteLength(response.output_text) <= 60000
        ) {
          try {
            output = JSON.parse(response.output_text) as unknown;
          } catch {
            output = { invalidText: response.output_text };
          }
        } else output = { truncated: true };
        if (entry.stage === 'grade') {
          const assessment = gradingOutput(response);
          if (!assessment) throw new Error('INVALID_OUTPUT');
          output = assessment;
        } else {
          if (
            response.status !== 'completed' ||
            Buffer.byteLength(response.output_text) > 64000
          )
            throw new Error('INVALID_OUTPUT');
          output = JSON.parse(response.output_text) as unknown;
          const context = {
            stage: entry.stage,
            candidate: entry.candidate as Parameters<
              typeof qualificationTask
            >[0]['candidate'],
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
          };
          output = qualificationTask(context, repair).schema.parse(output);
          validateQualificationTask(context, output);
        }
      } catch (e) {
        error =
          e instanceof Error && e.message === 'CHECK_FAILED'
            ? 'CHECK_FAILED'
            : 'INVALID_OUTPUT';
        if (
          output !== null &&
          Buffer.byteLength(JSON.stringify(output)) > 60000
        )
          output = { truncated: true };
      }
    } catch (e) {
      error =
        e instanceof OpenAI.APIConnectionError ||
        (e instanceof OpenAI.APIError &&
          (e.status === 408 ||
            e.status === 409 ||
            e.status === 429 ||
            (e.status ?? 0) >= 500))
          ? 'PROVIDER_TIMEOUT'
          : 'PROVIDER_REJECTED';
    }
    work = workSchema.parse(
      evaluationSql('complete', [
        work.id,
        work.lease,
        request,
        output,
        error,
        cents,
        usage,
      ]),
    );
  }
  return summary(work);
}
