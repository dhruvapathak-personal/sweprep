import { spawnSync } from 'node:child_process';
import OpenAI from 'openai';
import { z } from 'zod';
import { bundleSchema, contentDigest } from './manifest.ts';
import { providerBaseUrl, structuredRequest } from './provider.ts';
import { gradingOutput } from '../contracts/grading.ts';

import {
  qualificationConfiguration,
  sourceSnapshot,
  sourceReview,
  qualificationTask,
  validateQualificationTask,
} from './qualification-contract.ts';
export {
  qualificationConfiguration,
  qualificationIntake,
} from './qualification-contract.ts';

const workSchema = z.object({
  id: z.uuid(),
  lease: z.uuid().nullable(),
  state: z.enum(['queued', 'running', 'qualified', 'quarantined', 'rejected']),
  reason: z.string().nullable(),
  stage: z.string(),
  candidate: bundleSchema,
  evidence: z.array(sourceSnapshot),
  configuration: qualificationConfiguration,
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  dependencies: z.array(bundleSchema),
  artifacts: z.record(z.string(), z.unknown()),
  invalidTasks: z.array(z.string()),
  requestsUsed: z.number().int(),
});
type Work = z.infer<typeof workSchema>;

export function qualificationSql(operation: string, args: unknown[]) {
  const signatures: Record<string, string[]> = {
    open_batch: ['jsonb'],
    enqueue: ['uuid', 'uuid', 'jsonb'],
    claim: ['uuid'],
    reserve_cost: ['uuid', 'uuid', 'text', 'boolean', 'jsonb'],
    complete: [
      'uuid',
      'uuid',
      'text',
      'uuid',
      'jsonb',
      'text',
      'integer',
      'jsonb',
    ],
    finish: ['uuid', 'uuid'],
    yield: ['uuid', 'uuid', 'text'],
  };
  const signature = signatures[operation];
  if (!signature || signature.length !== args.length || !process.env.PGSERVICE)
    throw new Error('QUALIFICATION_DATABASE_REQUIRED');
  const literals = args.map((value, index) =>
    value === null
      ? 'null'
      : `'${(signature[index] === 'jsonb' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'::${signature[index]}`,
  );
  const result = spawnSync(
    'psql',
    ['-X', '-w', '-q', '-v', 'ON_ERROR_STOP=1', '-At'],
    {
      input: `select to_jsonb(private.qualification_${operation}(${literals.join(',')}));\n`,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1_000_000,
    },
  );
  if (result.status !== 0) {
    const code = [
      'STALE_LEASE',
      'REQUEST_LIMIT',
      'BUDGET_EXCEEDED',
      'QUALIFICATION_DISABLED',
      'LINEAGE_EXHAUSTED',
      'IMMUTABLE_REVISION_REQUIRED',
    ].find((code) => result.stderr?.includes(`ERROR:  ${code}`));
    throw new Error(code ?? 'QUALIFICATION_DATABASE_FAILED');
  }
  const output = result.stdout.trim();
  return output ? (JSON.parse(output) as unknown) : null;
}

function assertDispatch(work?: Work) {
  if (
    process.env.QUALIFICATION_ENABLED !== 'true' ||
    process.env.QUALIFICATION_MODEL_EVAL_APPROVED !== 'true' ||
    process.env.QUALIFICATION_PRIVACY_APPROVED !== 'true' ||
    process.env.QUALIFICATION_DEPLOYMENT_APPROVED !== 'true' ||
    !process.env.OPENAI_API_KEY
  )
    throw new Error('QUALIFICATION_DISABLED');
  if (!work) return;
  const config = work.configuration;
  if (
    Date.parse(config.expiresAt) <= Date.now() ||
    contentDigest(config) !== work.configurationDigest ||
    process.env.QUALIFICATION_CONFIGURATION_DIGEST !==
      work.configurationDigest ||
    process.env.QUALIFICATION_MODEL_EVALUATION_DIGEST !==
      config.modelEvaluationDigest ||
    process.env.QUALIFICATION_PRIVACY_APPROVAL_DIGEST !==
      config.privacyApprovalDigest ||
    process.env.QUALIFICATION_DEPLOYMENT_APPROVAL_DIGEST !==
      config.deploymentApprovalDigest ||
    process.env.QUALIFICATION_PROVIDER_CONFIGURATION_DIGEST !==
      config.providerConfigurationDigest
  )
    throw new Error('QUALIFICATION_DISABLED');
}

function execute(work: Work) {
  const review = sourceReview.parse(work.artifacts.source);
  const blocks =
    work.candidate.kind === 'question' ? work.candidate.payload.blocks : [];
  const code = blocks.flatMap((b, index) =>
    b.type === 'code' ? [{ ...b, blockIndex: index }] : [],
  );
  if (!review.executionRequired && !code.length && !review.executionPlan.length)
    return {
      status: 'not_applicable',
      reason:
        'The source review found no executable claim, and the candidate has no code blocks.',
    };
  if (
    !code.length ||
    review.executionPlan.length !== code.length ||
    new Set(review.executionPlan.map((p) => p.blockIndex)).size !==
      code.length ||
    code.some(
      (b) => !review.executionPlan.some((p) => p.blockIndex === b.blockIndex),
    )
  )
    throw new Error('EXECUTION_FAILED');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        'PATH',
        'HOME',
        'CI',
        'DOCKER_HOST',
        'XDG_RUNTIME_DIR',
        'QUALIFICATION_EXECUTOR',
        'QUALIFICATION_EXECUTOR_IMAGE',
      ].includes(key),
    ),
  );
  const result = spawnSync('python3', ['scripts/qualification-executor.py'], {
    input: JSON.stringify({
      blocks: code,
      toolchainVersion: work.configuration.toolchainVersion,
    }),
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 100000,
    env: { ...env, NODE_ENV: 'production' },
  });
  if (result.status !== 0) throw new Error('EXECUTOR_UNAVAILABLE');
  const output = z
    .object({
      status: z.literal('executed'),
      isolation: z.literal('network-disabled-v1'),
      toolchainVersion: z.literal(work.configuration.toolchainVersion),
      cpuSeconds: z.literal(5),
      wallSeconds: z.literal(10),
      memoryBytes: z.literal(268435456),
      outputBytes: z.literal(65536),
      readOnly: z.literal(true),
      credentialFree: z.literal(true),
      results: z
        .array(
          z
            .object({
              blockIndex: z.number().int(),
              exitCode: z.number().int(),
              stdout: z.string().max(65536),
              elapsedMs: z.number().nonnegative(),
              imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict()
    .parse(JSON.parse(result.stdout));
  if (
    output.results.length !== code.length ||
    output.results.some(
      (r) =>
        r.exitCode !== 0 ||
        r.stdout !==
          review.executionPlan.find((p) => p.blockIndex === r.blockIndex)
            ?.expectedStdout,
    )
  )
    throw new Error('EXECUTION_FAILED');
  return output;
}

export async function qualifyOnce(jobId: string | null = null) {
  assertDispatch();
  const claimed = qualificationSql('claim', [jobId]);
  if (!claimed) return null;
  const summary = z
    .object({
      id: z.uuid(),
      state: z.string(),
      reason: z.string().nullable(),
      requestsUsed: z.number(),
    })
    .parse(claimed);
  if (summary.state !== 'running') return summary;
  let work = workSchema.parse(claimed);
  while (work.state === 'running') {
    try {
      assertDispatch(work);
    } catch {
      return qualificationSql('yield', [
        work.id,
        work.lease,
        'QUALIFICATION_DISABLED',
      ]);
    }
    if (work.stage === 'finish')
      return qualificationSql('finish', [work.id, work.lease]);
    if (work.stage === 'execution') {
      let output: unknown = null;
      let error: string | null = null;
      try {
        output = execute(work);
      } catch (e) {
        error =
          e instanceof Error && e.message === 'EXECUTION_FAILED'
            ? e.message
            : 'EXECUTOR_UNAVAILABLE';
      }
      work = workSchema.parse(
        qualificationSql('complete', [
          work.id,
          work.lease,
          work.stage,
          null,
          output,
          error,
          null,
          null,
        ]),
      );
      continue;
    }
    const repair = work.invalidTasks.includes(work.stage);
    let task: ReturnType<typeof qualificationTask>;
    try {
      task = qualificationTask(work, repair);
    } catch {
      return qualificationSql('yield', [
        work.id,
        work.lease,
        'INPUT_TOO_LARGE',
      ]);
    }
    let request: unknown;
    try {
      request = qualificationSql('reserve_cost', [
        work.id,
        work.lease,
        work.stage,
        repair,
        {
          input: task.input,
          instructions: task.instructions,
          schema: task.jsonSchema,
          modelVersion: work.configuration.modelVersion,
          promptVersion: work.configuration.promptVersion,
          schemaVersion: work.configuration.schemaVersion,
          reasoningEffort: work.configuration.reasoningEffort,
        },
      ]);
    } catch (e) {
      if (
        e instanceof Error &&
        ['BUDGET_EXCEEDED', 'QUALIFICATION_DISABLED', 'REQUEST_LIMIT'].includes(
          e.message,
        )
      )
        return qualificationSql('yield', [work.id, work.lease, e.message]);
      throw e;
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
        structuredRequest(
          task,
          work.configuration.modelVersion,
          work.stage.startsWith('evaluate_')
            ? 'technical_grade'
            : 'content_qualification',
        ),
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
          response.status !== 'completed' ||
          Buffer.byteLength(response.output_text) > 64000
        )
          throw new Error('INVALID_OUTPUT');
        if (work.stage.startsWith('evaluate_')) {
          output = gradingOutput(response);
          if (!output) throw new Error('INVALID_OUTPUT');
        } else {
          output = JSON.parse(response.output_text) as unknown;
          output = task.schema.parse(output);
        }
        validateQualificationTask(work, output);
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
      qualificationSql('complete', [
        work.id,
        work.lease,
        work.stage,
        request,
        output,
        error,
        cents,
        usage,
      ]),
    );
  }
  return {
    id: work.id,
    state: work.state,
    reason: work.reason,
    requestsUsed: work.requestsUsed,
  };
}
