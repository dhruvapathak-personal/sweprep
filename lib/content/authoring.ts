import { spawnSync } from 'node:child_process';
import OpenAI from 'openai';
import { z } from 'zod';
import { authoredBundle, compileAuthoring } from './authoring-contract.ts';
import { contentDigest, bundleSchema } from './manifest.ts';
import { qualificationConfiguration } from './qualification-contract.ts';
import { providerBaseUrl } from './provider.ts';

const workSchema = z.object({
  id: z.uuid(),
  candidateId: z.uuid(),
  parentId: z.uuid().nullable(),
  version: z.number().int().positive(),
  state: z.enum(['queued', 'running', 'authored', 'quarantined', 'rejected']),
  lease: z.uuid().nullable(),
  reason: z.string().nullable(),
  plan: z.unknown(),
  configuration: qualificationConfiguration,
  configurationDigest: z.string(),
  repair: z.boolean(),
  requestsUsed: z.number().int(),
  bundle: bundleSchema.nullable(),
});
export function authoringSql(operation: string, args: unknown[]) {
  const signatures: Record<string, string[]> = {
    open: ['jsonb'],
    claim: ['uuid'],
    reserve: ['uuid', 'uuid', 'boolean'],
    complete: ['uuid', 'uuid', 'uuid', 'jsonb', 'text', 'integer', 'jsonb'],
    yield: ['uuid', 'uuid', 'text'],
    export: ['uuid'],
  };
  const signature = signatures[operation];
  if (!signature || signature.length !== args.length || !process.env.PGSERVICE)
    throw new Error('AUTHORING_DATABASE_REQUIRED');
  const literals = args.map((value, index) =>
    value === null
      ? 'null'
      : `'${(signature[index] === 'jsonb' ? JSON.stringify(value) : String(value)).replaceAll("'", "''")}'::${signature[index]}`,
  );
  const result = spawnSync(
    'psql',
    ['-X', '-w', '-q', '-v', 'ON_ERROR_STOP=1', '-At'],
    {
      input: `select to_jsonb(private.authoring_${operation}(${literals.join(',')}));\n`,
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
      'AUTHORING_DISABLED',
      'LINEAGE_EXHAUSTED',
      'IMMUTABLE_REVISION_REQUIRED',
    ].find((code) => result.stderr?.includes(`ERROR:  ${code}`));
    throw new Error(code ?? 'AUTHORING_DATABASE_FAILED');
  }
  return result.stdout.trim()
    ? (JSON.parse(result.stdout.trim()) as unknown)
    : null;
}
function dispatchGate(work?: z.infer<typeof workSchema>) {
  if (
    process.env.AUTHORING_ENABLED !== 'true' ||
    process.env.QUALIFICATION_MODEL_EVAL_APPROVED !== 'true' ||
    process.env.QUALIFICATION_PRIVACY_APPROVED !== 'true' ||
    process.env.QUALIFICATION_DEPLOYMENT_APPROVED !== 'true' ||
    !process.env.OPENAI_API_KEY
  )
    throw new Error('AUTHORING_DISABLED');
  if (!work) return;
  const plan = compileAuthoring(
    work.plan && typeof work.plan === 'object' && 'spec' in work.plan
      ? work.plan.spec
      : null,
  );
  const config = work.configuration;
  if (
    contentDigest(plan) !== contentDigest(work.plan) ||
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
      config.providerConfigurationDigest ||
    process.env.AUTHORING_RUN_AUTHORIZATION_DIGEST !==
      plan.spec.authorization.runAuthorizationDigest
  )
    throw new Error('AUTHORING_DISABLED');
  return plan;
}
function summary(work: z.infer<typeof workSchema>) {
  return {
    id: work.id,
    state: work.state,
    reason: work.reason,
    requestsUsed: work.requestsUsed,
  };
}
export async function authorOnce(id: string) {
  dispatchGate();
  const claimed = authoringSql('claim', [z.uuid().parse(id)]);
  if (!claimed) return null;
  let work = workSchema.parse(claimed);
  while (work.state === 'running') {
    let plan: ReturnType<typeof compileAuthoring>;
    try {
      plan = dispatchGate(work)!;
    } catch {
      return summary(
        workSchema.parse(
          authoringSql('yield', [work.id, work.lease, 'AUTHORING_DISABLED']),
        ),
      );
    }
    let request: unknown;
    try {
      request = authoringSql('reserve', [work.id, work.lease, work.repair]);
    } catch (e) {
      if (
        e instanceof Error &&
        ['BUDGET_EXCEEDED', 'AUTHORING_DISABLED', 'REQUEST_LIMIT'].includes(
          e.message,
        )
      )
        return summary(
          workSchema.parse(
            authoringSql('yield', [work.id, work.lease, e.message]),
          ),
        );
      throw e;
    }
    let bundle: unknown = null;
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
        work.repair ? plan.requests.repair : plan.requests.original,
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
        bundle = authoredBundle(
          plan.spec,
          work,
          JSON.parse(response.output_text),
        );
      } catch (e) {
        error =
          e instanceof Error && e.message === 'CHECK_FAILED'
            ? 'CHECK_FAILED'
            : 'INVALID_OUTPUT';
      }
    } catch (e) {
      error =
        e instanceof OpenAI.APIConnectionError ||
        (e instanceof OpenAI.APIError &&
          [408, 409, 429].includes(e.status ?? 0)) ||
        (e instanceof OpenAI.APIError && (e.status ?? 0) >= 500)
          ? 'PROVIDER_TIMEOUT'
          : 'PROVIDER_REJECTED';
    }
    work = workSchema.parse(
      authoringSql('complete', [
        work.id,
        work.lease,
        request,
        bundle,
        error,
        cents,
        usage,
      ]),
    );
  }
  return summary(work);
}
