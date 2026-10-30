# Imported-candidate qualification

The Node 24 operator CLI processes immutable candidates already installed by the offline importer. It does not generate a bank, fetch a URL, scrape a website, publish, revoke or modify learner data. No paid call, hosted write, model-release evaluation or live activation is authorized by installing this code. The separate [independent release-evaluation path](model-release-evaluation.md) can prepare the retained record for a later release decision; it does not require or grant the qualifier's prior model approval.

## Authority and gates

- A DB administrator may explicitly grant `qualification_operator` to an intake login and `qualification_worker` to a separate worker login. Neither has table access, learner-answer/grade access, publication authority or generic receipt-writing authority. No migration grants memberships. Keep `private` outside PostgREST's exposed schemas.
- The operator can open an immutable bounded batch and enqueue an imported candidate with authorized supplied snapshots. The worker can claim a leased job, reserve one request, append its artifacts, yield and finalize. Functions use fixed search paths. Only the non-login execution role derives receipts.
- `QUALIFICATION_ENABLED`, `QUALIFICATION_MODEL_EVAL_APPROVED`, `QUALIFICATION_PRIVACY_APPROVED` and `QUALIFICATION_DEPLOYMENT_APPROVED` default to false. Provider dispatch also requires `OPENAI_API_KEY`, the exact configuration digest and the four matching approval/evidence digests in `.env.example`. Do not use grading approvals as qualification approvals.
- Approvals are operator attestations tied to retained evaluation/privacy/deployment/provider records, not self-proving hashes. Hashes from synthetic tests never establish live quality or complete these gates. The exact pinned model, prompt, schema, fixture and toolchain configuration must have independent release evaluation. Publication remains a separate capability and is always false in a qualification batch.
- Use protected libpq service/pass files or a secret manager. Each CLI invocation requires an explicitly selected `PGSERVICE`. Do not put passwords, credentials, employer material or learner answers in arguments, files, evidence, provider prompts or logs. No hosted scheduler is configured.

## Configuration and intake

The strict configuration contract is `qualificationConfiguration` in `lib/content/qualification-contract.ts`. It requires:

- `policyVersion=content-policy-v2`, `modelVersion=gpt-5.4-mini-2026-03-17`, `promptVersion=qualification-prompts-v2`, `schemaVersion=qualification-schema-v2`, `fixtureVersion=machine-fixtures-v2`, `graderVersion=grader-v2`, `gradingPromptVersion=grade-prompt-v2`, `gradingSchemaVersion=grade-schema-v1` and an approved `toolchainVersion`.
- `modelEvaluationProtocolVersion=release-evaluation-v2` and SHA-256 `modelEvaluationDigest`, `privacyApprovalDigest`, `deploymentApprovalDigest` and `providerConfigurationDigest`, each identifying its separately retained approval record.
- `enabled=true`, `publicationEnabled=false`, `requestCents=10`, an explicit future UTC `expiresAt`, positive `dailyCap` at most 1000 cents, `monthlyCap` at most 2000 cents, and a bounded `batchCap` at most 2000 cents.

`QUALIFICATION_CONFIGURATION_DIGEST` is the recursively sorted-key UTF-8 JSON SHA-256 digest of that exact configuration, computed with `contentDigest`. Set the four corresponding environment digests to those in the approved configuration. A changed digest cannot reuse an existing job or reset its allowance.

The intake JSON contains only `candidateId`, `batchId` and `evidence`. Every correctness source needs one snapshot containing:

- Its exact `sourceId`, `url`, `edition` and `locator`, matching the imported source record.
- `authority`: `standard`, `official_documentation` or `original_paper`.
- Nonempty `permissionBasis` and `provenance` describing why this supplied material may be processed and where the exact snapshot came from.
- Public source `text`, at most 10,000 characters, and its plain UTF-8 SHA-256 `digest`. This is not the canonical-JSON digest of a quoted string. Permitted reuse must also match the imported payload digest, rights basis and attribution.

The worker reads only these supplied snapshots. A URL, interview-bank discovery record, a digest without text, or a model's recalled source is not correctness evidence. An operator must verify source provenance, rights and the authority designation before intake. Snapshot permission does not grant permission to reproduce source wording in a candidate.

From the repository root:

```bash
PGSERVICE=qualification-intake node scripts/content-qualify.ts batch /protected/approved-batch.json
PGSERVICE=qualification-intake node scripts/content-qualify.ts enqueue /protected/intake.json
PGSERVICE=qualification-worker node scripts/content-qualify.ts once JOB_UUID
```

`batch` and `enqueue` never load source URLs or call a provider. `once` processes at most one job; omit its UUID to claim one due job. It prints only job/state/reason/request counts, not source text, prompts or credentials. A queued budget/approval result requires operator attention; do not run a tight retry loop. Stopping or crashing a worker cannot refund an unknown provider charge.

## Qualification evidence

1. Deterministic checks validate the stored bundle again, exact snapshots/claim-source roles/rights, privacy patterns, qualified dependency digests and versioned token-Jaccard similarity. `jaccard-v1` lowercases the entire payload JSON, splits on non-alphanumeric/non-underscore characters and compares unique-token sets against other stable identities of the same kind. Scores at least 0.85 quarantine; same-identity immutable revisions do not count as duplicates. Finalization checks the current bank again.
2. A source-review task independently solves and checks mapped claims with exact supporting quotations, assumptions, privacy, originality and execution applicability. A separate fixture-author request sees the candidate and sources, not the source-review verdict.
3. A separate critic independently solves without the source-review answer/verdict. It sees the actual candidate, source snapshots, execution record, machine fixtures and exact dependent term definitions. It challenges alternatives, every fixture expectation/range, and each question-term link for required-answer and distractor spoilers. Any unresolved objection blocks qualification.
4. Questions require five machine-authored cases: wrong, partial, borderline pass, strong and non-answer. All five are scored with integer bounds and Boolean pass expectations. Passing ranges start at 4; failing ranges end below 4. A separate release-only uncertainty control has defective context and never enters candidate intakes. Five independent requests use the exact learner grading instructions, structured schema and input shape, under separate qualification authority. They see only the question, assumptions, rubric and synthetic answer, without the fixture's kind or expectations.
5. The DB compares stored outputs, fixture ranges and derived pass/fail, and derives a receipt bound to the bundle, source/configuration/evidence/artifact digests, exact dependencies, actual request counts and distinct persisted task IDs. It accepts no caller-supplied `passed` receipt. The existing publisher can consume this receipt, but the qualifier never invokes it.

For an imported candidate, receipt `authorTask` means the persisted **source-review/independent-solving task**, not the candidate's historical author. Candidate origin remains the import's declared provenance; this worker cannot establish an unknown original author's identity. Source reviewer, fixture author and critic are independent requests with separately stored inputs and roles, not different verdict strings from one response.

Term-only jobs use source review and critique. Their receipts explicitly mark question fixtures/grading as not applicable; legacy `checks=pass` records a satisfied policy gate, not a claim that question grading occurred. Machine consistency fixtures are not human gold, independent model-release evaluation, assessed mastery or hiring-readiness evidence.

## Execution boundary

Execution is a separate, explicitly configured operator process. Do not add an engine socket, privileged mode or extra capabilities to the app/release profiles. Deployment mode is `QUALIFICATION_EXECUTOR=podman`, which requires rootless Podman and cgroup v2. `docker-ci` is available only with `CI=true`, through a local Unix engine socket, and does not establish Podman developer/deployment support.

`QUALIFICATION_EXECUTOR_IMAGE` must identify a preinstalled exact `sha256:…` image ID or repository digest. There is no image pull in the worker. Its configuration must bind `toolchainVersion=disposable-v1@EXACT_IMAGE_REFERENCE`. The approved image needs Python 3, `/usr/bin/env`, and, for C++, `sh` and `c++`. Python uses isolated mode; C++ compiles with `-std=c++20 -O0`. Different language-standard assumptions require a different reviewed toolchain, not an unreported fallback.

The disposable container has no network or credentials, a read-only root/input, unprivileged UID/GID, dropped capabilities, no-new-privileges, bounded scratch storage/pids and no engine socket. Limits are 5 seconds CPU, 10 seconds total execution-task wall time, 256 MiB memory with no swap and 64 KiB total captured output. CPU quota is at most half a CPU within the wall deadline; each process also has a hard five-second CPU limit. Before candidate code runs, the runner inspects actual container controls and a fixed in-container probe verifies the kernel's cgroup limits, read-only root, loopback-only interface, empty capabilities, no-new-privileges and scrubbed environment. Missing or inconsistent controls block execution.

Every supplied code block must run unchanged, once, with a matching source-reviewed prediction and successful exit. Prose claims that require execution but have no executable supplied block are blocked. Missing isolation is never converted to “not applicable.” Execution cannot prove absence of undefined behavior, all interleavings/schedules, portability, or universal correctness; the critic must retain those limits.

## Recovery and budgets

Jobs have 90-second leases. Stored inputs, batch configurations, checks and artifacts are immutable. Concurrent claim uses row locks; stale completion/finalization fails; successful finalization is idempotent. Identical intake replay returns the existing job without new allowance. Changed evidence/configuration requires an explicitly imported immutable revision and a new audited operator batch.

A first failure quarantines. Only one explicitly imported child revision can start the second run; another failure rejects the lineage. The qualifier never generates that revision or automatically requeues a terminal decision. The separate bounded conceptual author can prepare a revision under a new authorized batch. Questions allow at most 12 outbound requests per run and 24 per two-run lineage; terms allow 3 and 6. Each task allows at most 3 dispatches and one schema repair. SDK retries are zero. Transient failures consume a durable slot; crashes retain the reservation and request count.

Authoring, qualification, independent evaluation and learner grading reserve in the same ledger under the same atomic lock. Each request reserves 10 cents before transport. Known usage settles at the pinned model's $0.75/$4.50 per million input/output tokens; unknown or inconsistent usage retains the full reservation. The batch cap and the combined daily/monthly ceilings apply before dispatch. The conservative recommendation remains 100 cents/day. There is no separate qualification budget that can exceed the 1000/2000-cent maximum.

## Reproducible checks and limits

Run the repository's static/unit/build checks, Python setup tests, and guarded isolated DB/HTTP suite described in the README. The qualification tests invoke the actual CLI, private SQL functions, worker and real provider SDK with a mocked transport. They check role denials, source/rights/privacy/duplicates, critic/spoiler objections, five-case grading mismatches, repair/timeout/replay/stale/concurrency/lineage/shared-budget limits and synthetic publisher compatibility. These are implementation checks, not live model-quality results.

An actual pinned-image executor attempt in the factory sandbox failed closed: its Docker compatibility engine reported an unlimited swap setting and a writable input mount despite the requested controls. Candidate code did not start. Successful code execution and rootless-Podman host behavior remain unverified and must pass in an approved deployment boundary before executable content can qualify. No hosted project, live model, publication, correction or runtime activation was exercised.

The separate [conceptual authoring path](conceptual-authoring.md) supplies original private bundles to this importer/qualifier. Authoring requests count inside the same candidate-run and lineage allowance. V2 receipts include the exact release digest; learner dispatch must match it. Historical v1 evidence stays immutable and cannot qualify as v2.
