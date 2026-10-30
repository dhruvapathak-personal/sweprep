import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  compileEvaluation,
  evaluationConfiguration,
  loadPrivatePackage,
  offlineEvaluation,
  persistPrivateReport,
  evaluationCodeIdentity,
} from '../lib/content/evaluation-contract.ts';
import {
  evaluateOnce,
  evaluationSql,
} from '../lib/content/model-evaluation.ts';

const [mode, ...args] = process.argv.slice(2);
try {
  let result: unknown;
  if (mode === 'identity' && !args.length) result = evaluationCodeIdentity();
  else if (mode === 'once' && args.length === 1)
    result = await evaluateOnce(z.uuid().parse(args[0]));
  else if (mode === 'export' && args.length === 2) {
    const report = evaluationSql('export', [z.uuid().parse(args[0])]);
    if (!report) throw new Error('REPORT_REQUIRED');
    result = persistPrivateReport(args[1], report);
  } else if (
    (mode === 'offline' && args.length === 3) ||
    (mode === 'enroll' && args.length === 2)
  ) {
    const input = loadPrivatePackage(args[0]);
    const bytes = readFileSync(args[1]);
    if (bytes.length > 10000) throw new Error('INPUT_TOO_LARGE');
    const config = evaluationConfiguration.parse(
      JSON.parse(bytes.toString('utf8')),
    );
    if (mode === 'offline') {
      const report = offlineEvaluation(input, config);
      if (report.deterministicPolicyStatus !== 'matched') process.exitCode = 1;
      result = {
        ...persistPrivateReport(args[2], report),
        identity: report.identity,
        packageDigest: report.packageDigest,
        status: report.status,
        deterministicPolicyStatus: report.deterministicPolicyStatus,
        dispatchBlockers: report.dispatchBlockers,
        requestsUsed: 0,
        costCents: 0,
        cases: report.cases,
      };
    } else {
      const plan = compileEvaluation(input, config);
      if (
        plan.cases.some(
          (c) =>
            c.stage === 'policy' &&
            c.policyIssues.join() !== c.expected.policy.join(),
        )
      )
        throw new Error('POLICY_EXPECTATION_MISMATCH');
      result = {
        runId: evaluationSql('open', [plan]),
        identity: plan.identity,
        packageDigest: plan.packageDigest,
      };
    }
  } else throw new Error('INVALID_COMMAND');
  console.info(JSON.stringify(result));
} catch (error) {
  const safe = [
    'INVALID_COMMAND',
    'INPUT_TOO_LARGE',
    'ATTACHMENT_INVALID',
    'RIGHTS_RECORD_REQUIRED',
    'EVIDENCE_ATTACHMENT_REQUIRED',
    'PACKAGE_DIGEST_MISMATCH',
    'CODE_MISMATCH',
    'REQUEST_MISMATCH',
    'CASE_EXPECTATION_INVALID',
    'CASE_FACETS_INVALID',
    'CASE_EVIDENCE_INVALID',
    'CANDIDATE_INPUT_INVALID',
    'HOLDOUT_IDENTITY_INVALID',
    'COVERAGE_INCOMPLETE',
    'REPORT_REQUIRED',
    'POLICY_EXPECTATION_MISMATCH',
    'REPORT_CONFLICT',
    'EVALUATION_DISABLED',
    'EVALUATION_DATABASE_REQUIRED',
    'EVALUATION_DATABASE_FAILED',
    'EVALUATION_REVISION_REQUIRED',
    'EVALUATION_INPUT_INVALID',
    'STALE_LEASE',
    'REQUEST_LIMIT',
    'BUDGET_EXCEEDED',
  ];
  console.error(
    error instanceof Error && safe.includes(error.message)
      ? error.message
      : 'EVALUATION_FAILED',
  );
  process.exitCode = 1;
}
