# Independent model-release evaluation

This is a separate operator path, not the qualifier's machine-consistency fixtures. Installing it does not approve a model, enable a provider, qualify content, publish content, or change learner data. The v3 implementation uses synthetic mocked transport and isolated services. Historical v1/v2 paid evaluations found unresolved mismatches; they do not approve v3. No hosted deployment or successful executable sandbox run was verified.

The approved [offline calibration rules](offline-grading-calibration-spec.md) govern the v3 runtime contracts without new score thresholds or rights exemptions. Original v1/v2 packages, expectations, observations, reports and ledger remain unchanged and exportable. Old approvals cannot authorize v3 dispatch; unfinished incompatible work is blocked by a forward migration.

## Public implementation and private operational data

This repository is public. Actual questions, canonical rubrics, source-linked answer keys, independent holdout answers and detailed operational reports belong in the permission-checked private archive delivered with the implementation. They are supplemental operational input, intentionally not intended for merging. Production code, schemas, tests and this guide remain in the reviewed PR. Tests in the public repository use explicitly synthetic non-curriculum data only.

Engineering review requires no answer keys. Optional private content inspection is not a mandatory content-review gate. A later independent release decision must assess the retained report and its limits without turning model agreement into truth.

The first private archive contains three newly authored conceptual questions, six linked terms, fifteen independently prepared reference-derived cases, a strict manifest, batch-free intake templates, complete official-source files, exact source excerpts/digests, the full license, a changes notice and an offline report. The sources are the official CPython documentation pinned to `v3.14.0`, under PSF License Version 2. Full-file hashes and exact contiguous excerpt locators are retained privately. No interview-bank material, learner answers or credentials are included. Nothing is imported, qualified or published by downloading it.

## Load and verify without dispatch

Download the permission-checked archive and take ownership of a durable copy before the sandbox expires. Compare its SHA-256 with the handoff, then extract it into a private directory outside this checkout. Do not paste JSON into Slack, GitHub, terminal logs or learner-visible catalogs.

Use Node 24 with the exact delivered code and lockfile. The archive's `README.txt` identifies the code and the expected package/report digests. From the repository root:

```bash
node scripts/content-evaluate.ts identity
node scripts/content-evaluate.ts offline /protected/package.json /protected/offline-configuration.json /protected/reports
node scripts/content-import.ts dry-run /protected/manifest.json
```

`identity` prints only source-file hashes. `offline` reads local files and writes a content-addressed report with mode `0600`; it performs no DB/provider operation and never fetches source URLs. Its strict loader checks the package/manifest/bundle checksums, exact pinned contracts, independent case identities, coverage, expected ranges, snapshot digests, dependency digests, license/notice presence and all attachment bytes. Non-policy source excerpts must occur unchanged in their retained source attachment. Traversal and symlink escapes fail. Missing/invalid input stops with a safe error code. A deterministic policy-expectation mismatch retains its report and exits nonzero.

The shipped offline configuration has zero budgets and null approval records. Its result is `not_evaluated`, with `ZERO_BUDGET` and `AUTHORIZATION_REQUIRED`. An offline success means only that inputs and deterministic expectations match. It is not a model pass or an authorization.

The canonical package digest hashes the recursively sorted-key package JSON excluding its own `digest`. Source/file/archive SHA-256 values hash their exact bytes. Report files use canonical JSON plus a newline; their names hash the report object without that newline. Do not interchange these digests. Repeating identical offline inputs produces the same report; an existing different file is not overwritten.

Original v1/v2 archives remain historical and do not satisfy v3 intake. Freeze genuinely new independent source-derived cases, immutable candidate/rubric/evidence identities and a new dataset/package before v3 evaluation. Relabeling previously observed holdouts is not fresh validation. Use the existing importer under `content_importer` only after the independent release and operational approvals. New intake entries need the exact separately approved qualification batch ID. An evaluation enrollment does not import candidates or create a qualification batch. No such import, qualification or publication is authorized by this handoff.

## Cases and production identity

The strict package/configuration contracts are in `lib/content/evaluation-contract.ts`. The dataset fixes its ID/version, evidence, candidate/dependency versions, answers, expected outcomes and reference quotations before evaluation. Holdouts must not reuse the staged candidates' identities. Changing labels or thresholds is a new audited baseline, never a silent repair to make a report agree.

Coverage requires policy/source/fixture-author/critic/grading stages, negative source and critic cases, a rights-invalid case and five scored grading boundaries (wrong, partial, borderline pass, strong and non-answer) plus a separate `uncertain_context` negative control. The control has insufficient or contradictory assessment context and must produce uncertainty with a specific reason. It stays outside candidate intakes. Additional private cases exercise incorrect fixtures, unsafe contextual term disclosure, private-material patterns, digest drift and snapshot mismatch. Deliberately invalid policy inputs are classified without provider dispatch.

Requests use the actual shared qualification prompts/schemas/validators and the actual learner grading instructions/schema/input shape. Both ordinary and repair bodies are frozen and persisted before transport. The runtime recompiles the entire plan from the frozen package and exact current production source hashes before dispatch; a changed request, source, configuration or code identity blocks it. Source reviewer and critic remain separate requests. The critic does not receive the source reviewer's answer or verdict. Grade requests receive no case kind or expected range.

The independent expected outcomes are prepared from official references, not from the outputs being evaluated. They are not externally calibrated human gold, proof of universal correctness or hiring-readiness evidence. Novel fixture-author answers receive structural/grounding checks; there is no independent semantic oracle for every generated answer. Reports retain this limitation through the frozen package. The deployment scope is conceptual and non-executable; it does not establish rootless-Podman support or bypass the existing executable-content boundary.

## Narrow authority

Migration `202610290007_model_evaluation.sql` creates non-login `evaluation_operator`, `evaluation_worker` and `evaluation_engine` roles. It grants no application-login memberships. A DB administrator must select separate intake and worker logins explicitly. PostgreSQL can retain its creator's administrative, non-inheritable/non-settable role-management record; it does not grant application execution rights.

The operator can freeze one plan and privately export it with its report. The worker can claim its leased run, reserve a frozen request, append an observation, yield and finalize. Neither has direct table access. The non-login engine has no learner-answer/grade/rubric access, candidate access, qualification receipt writer, importer or publisher capability. Its provider-ledger writes are restricted to evaluation-owned rows. The existing learner settlement function cannot settle evaluation or qualification requests. No generic receipt writer is introduced.

Keep `private` outside PostgREST's exposed schemas. Use protected libpq service/pass files or a secret manager, never inline passwords. Every DB invocation requires an explicit `PGSERVICE`. Enrollment/export use operator authority; execution uses worker authority. Detailed exports contain private keys and must remain private.

## Separately authorized live command

The complete v3 live path is implemented but was **not run**. It needs no prior model-evaluation approval. Qualification and learner-grading approvals are not substitutes for its independent gates.

An operator must first retain separate provider-account/data-policy, privacy, conceptual deployment and run-authorization records. Their digests are attestations backed by those records, not self-proving hashes. The exact pinned live configuration requires:

- The protocol/model/prompt/schema/fixture/grader/policy identities specified by `evaluationConfiguration`, the current `codeDigest`, and `toolchainVersion=conceptual-no-execution-v1`.
- `reasoningEffort=low`, standard `service_tier=default`, `max_output_tokens=3000` including reasoning tokens, a 30-second timeout and zero SDK retries. There is no model, tier, effort or environment fallback.
- `inputUsdPerMillion=0.75`, `outputUsdPerMillion=4.5`, `requestCents=10`, positive daily/monthly/batch budgets and a future UTC expiry.
- A daily cap at most 1000 cents, monthly and batch caps at most 2000 cents, `maxRequests` at most 180, and four non-null approval/authorization digests.
- `mode=live` for real observations. `mode=mock` labels isolated transport tests as not evaluated; it is provenance, not a built-in free simulator or a bypass of any spend/authorization gate.

All of these environment flags must explicitly equal `true`: `MODEL_EVALUATION_ENABLED`, `MODEL_EVALUATION_PROVIDER_POLICY_APPROVED`, `MODEL_EVALUATION_PRIVACY_APPROVED`, `MODEL_EVALUATION_DEPLOYMENT_APPROVED` and `MODEL_EVALUATION_RUN_AUTHORIZED`. They default to disabled.

The worker also requires `OPENAI_API_KEY` from a secret store and exact `MODEL_EVALUATION_CONFIGURATION_DIGEST`, `MODEL_EVALUATION_PACKAGE_DIGEST`, `MODEL_EVALUATION_PROVIDER_POLICY_DIGEST`, `MODEL_EVALUATION_PRIVACY_APPROVAL_DIGEST`, `MODEL_EVALUATION_DEPLOYMENT_APPROVAL_DIGEST` and `MODEL_EVALUATION_RUN_AUTHORIZATION_DIGEST`. Do not enable these to repeat the offline validation.

Only after that separate authorization:

```bash
PGSERVICE=evaluation-intake node scripts/content-evaluate.ts enroll /protected/package.json /protected/approved-live-configuration.json
PGSERVICE=evaluation-worker node scripts/content-evaluate.ts once RUN_UUID
PGSERVICE=evaluation-intake node scripts/content-evaluate.ts export RUN_UUID /protected/exports
```

Console output contains only IDs, safe status/reason codes, counts, digests and costs. Private exports preserve the complete frozen plan, expected outcomes, exact requests, observations, usage and report. A report/digest cannot change environment flags or produce a qualification/publication receipt.

## Bounds, recovery and reports

All four provider paths reserve in `private.provider_requests` under advisory lock `461920`. A reservation commits before the SDK call. SDK retries are zero. Known bounded usage settles at pinned prices using total output tokens, including reasoning tokens, not only visible text; missing, inconsistent or crashed-call usage retains the full ten-cent reservation. Daily/monthly UTC totals combine grading, authoring, qualification and evaluation. A run additionally enforces its batch cap and durable request allowance.

Plans, evidence, observations and reports are immutable. Identical enrollment returns the existing run, including after completion or a crash. Changed budgets, expiry or authorization cannot replace it. Reusing a package ID with different content or a dataset ID/version with different evidence/expectations fails. A separate study-scope identity ignores package/case labels, case order, bundle UUIDs/stable labels/version lineage, source labels/access timestamps and derived bundle digests. It resolves dependency and term links to normalized content identities and source references to retained source metadata, preserving payloads, source editions/rights, evidence bytes and expected outcomes. Relabeling identical cases under the same model/protocol/code cannot replenish allowance. The supplied dependency graph must be complete and acyclic. Meaningful baseline changes require a new audited dataset version and package identity; they remain subject to the shared ledger.

One run has 9–60 cases, at most three requests per case and one schema repair. Crashes consume their persisted slots. A lost repair is not issued again. Runs have 90-second leases; concurrent claim chooses one worker, stale completion/reservation fails, and completed finalization is idempotent. Budget/approval yields retain the same run and reservations. Do not poll them tightly or restart to obtain a new allowance. Expired frozen authorization cannot be renewed in place.

The database derives scored pass/fail from the stored score, frozen pass threshold and critical-claim flag. It reports score-range violations, pass/fail reversals, uncertainty-context outcome reversals, false source/critic acceptance, invalid output and transport/request-limit failures. It derives source/fixture/critic acceptance from stored output as well as checking the worker validator result; an empty observation labeled `CHECK_FAILED` earns no negative-case credit. Version-2 packages require explicit `expected.facets` for source and critic cases: privacy, originality, every claim/source verdict, every fixture-kind verdict and every exact term-ID/exposure verdict. Other stages require null facets. Target negative findings and positive control facets must match independently of overall `accepted`; no case ID implies an expectation. V3 reports include `schemaVersion=evaluation-report-v3` and per-case `facetResults` with expected, observed and matched values. An unrelated privacy or rights rejection cannot mask an incorrect target finding.

Reports separate `deterministic_policy`, `mock_transport` and real `model_observation` cases. Offline and mock reports remain `not_evaluated` even if their conformance expectations match. Live reports say `observed_mismatches` or `observations_complete`, never “approved.” All reports carry `approvalAuthority=none`. A human engineering/risk decision and separately retained release record are still required before any later qualification activation; no mandatory human answer-key pre-review is introduced.

## Verification

Run the documented format, lint, typecheck, unit, build, Python setup and guarded isolated DB/HTTP commands in the README. The dedicated evaluator tests use the actual worker/SDK with synthetic mocked transport and real isolated private SQL capabilities. They cover immutable replay, forged/empty observations, expected reversals and uncertainty, wrong approvals/zero budgets, bounded repair/crash recovery, concurrent claim, cross-role/HTTP denials and the shared grading/qualification budget. Generated public DB types must remain in parity; all new evaluation tables/functions are private.

The conservative daily recommendation remains 100 cents; the authorized implementation ceilings are 1000 cents/day and 2000 cents/month across all paths. A new database is not an account-global billing ledger. Retain and deduct known external or earlier-run spend before selecting a new bounded cap; never fabricate historical provider requests to carry a balance.

The fixed low reasoning baseline differs from historical v2 effort `none`. No result establishes that low improves quality, and a future comparison is not prompt-only evidence. Shared scoring anchors are role-neutral; grader-only assessment duties stay in grade requests. One of two required claims is half, and score 5 requires every predeclared excellence component unless the rubric explicitly awards 5 for a fully correct answer.
