# Bounded conceptual authoring

This disabled Node 24 path turns one coverage intent and supplied permitted official snapshots into one original private question or term bundle. It does not fetch sources, crawl, schedule work, author executable content, qualify its own output, publish, or access learner data. Installation and synthetic checks authorize no paid call or hosted operation.

## Persisted work and authority

An administrator may grant `authoring_operator` to an intake/export login and `authoring_worker` to a separate worker login. Neither role has table access, importer, qualifier, publisher, or learner-data authority. The non-login engine has only the private content/configuration reads needed to validate dependencies and preserve lineage. Keep `private` outside exposed API schemas.

Open an independently approved qualification batch first, with the exact v3 release record and `toolchainVersion=conceptual-no-execution-v1`. The strict `authoringSpecification` contract requires:

- An operation UUID, batch UUID, nullable prior authoring UUID, `question` or `term`, stable identity, bounded coverage intent and fixed domain. A question needs a curriculum `skillId`; a term uses null.
- Correctness source metadata and exact snapshots with byte digests, authority, provenance and processing permission. Discovery material cannot provide evidence. Reproduction rights remain a separate independent review decision.
- Exact previously qualified term bundles for selected dependencies. A term has no dependencies.
- `conceptual-authoring-prompts-v2`, `conceptual-authoring-schema-v1`, the current production `codeDigest`, and a retained run-authorization digest. These authoring identities are separate from the v3 grading/qualification identities.

The operator freezes both ordinary and repair request bodies, source/code hashes, candidate identity and shared lineage before dispatch. Replaying the operation returns the same job. Relabeling an identical coverage/source scope cannot create another allowance. The worker recompiles and compares the frozen plan before every dispatch.

`AUTHORING_ENABLED` defaults to false. Dispatch also needs the existing qualification model-release/privacy/deployment flags, exact qualification configuration and approval digests, `AUTHORING_RUN_AUTHORIZATION_DIGEST`, and a securely supplied `OPENAI_API_KEY`. Hashes identify retained approvals; they are not approvals themselves. No model-release record may be self-approved.

## Commands and private handoff

Run from the repository root with protected libpq service/pass files:

```bash
PGSERVICE=authoring-intake node scripts/content-author.ts open /protected/authoring.json
PGSERVICE=authoring-worker node scripts/content-author.ts once AUTHORING_UUID
PGSERVICE=authoring-intake node scripts/content-author.ts export AUTHORING_UUID /protected/handoff.json
```

`open` performs no provider call. `once` handles one job with 90-second leases and prints only safe IDs, state, reason and counts. `export` creates an owner-only file without overwriting an existing path. It contains the standard manifest, exact qualification intake and private authoring plan/request/artifact audit record. It does not import or approve the draft.

Under a separate authorized intake process, save the handoff's `manifest` and `intake` objects as protected JSON files. Run the existing importer and qualifier:

```bash
node scripts/content-import.ts dry-run /protected/manifest.json
PGSERVICE=content-import node scripts/content-import.ts import /protected/manifest.json
PGSERVICE=qualification-intake node scripts/content-qualify.ts enqueue /protected/intake.json
PGSERVICE=qualification-worker node scripts/content-qualify.ts once JOB_UUID
```

The DB requires the exact authored candidate, bundle, snapshots and batch at handoff. Copied/relabelled authored bundles cannot obtain a fresh qualification allowance. Source review, fixture author, critic and each grader remain separate persisted requests. Execution-required findings block conceptual content; they never become “not applicable” merely because no executor is available. Publication remains separate and uninvoked.

## Bounds and recovery

Authoring and qualification share 12 requests per question run/24 per lineage, or 3 per term run/6 per lineage. A normal conceptual question uses one authoring request plus eight qualification requests. A normal term uses one plus two. Each task allows at most three dispatches and one schema repair; SDK retries are zero.

A first terminal failure quarantines. One separately approved new batch may produce a revision of that authoring job. It retains the same lineage and uses a new immutable candidate/version when a prior candidate was imported. A failed second run rejects. Replays, expired leases, relabeling and crashes do not refund slots or unknown costs.

All four provider paths use the same atomic daily/monthly ledger. Authoring and qualification also share the batch total. Each dispatch reserves 10 cents; unknown usage and provider errors retain that reservation. Validated bounded token usage settles at the pinned prices. Defaults remain disabled/zero; 100 cents/day remains the conservative recommendation, within hard ceilings of 1000 cents/day and 2000 cents/month.

## Operational path to at least fifteen questions

1. Complete adversarial engineering review of the exact branch and hashes. Keep the original v1/v2 archives, reports and ledger unchanged. Freeze genuinely new source-derived private v3 holdouts in a new evaluation package, source attachments, expectations and separate authorization records before observing outputs.
2. Run one bounded independent v3 release evaluation in an approved isolated runtime. Export its exact requests, observations, usage and report. The report has no approval authority. Obtain the genuine human exact-v3 model-release/risk decision before authoring/qualification activation; no answer-key pre-review is required.
3. After operational GO, freeze at least fifteen distinct conceptual coverage intents using only retained permitted official snapshots. Author questions individually, and terms only where needed. Feed each successful private handoff through the existing importer and independent qualifier. Count only stored `qualified` receipts, not drafts, fixtures or mock results. Use at most one revision per lineage and stop on rights, evidence, execution or budget blockers.
4. Retain every private manifest, source/permission record, lineage, request and receipt. Deduplicate against the bank at finalization. Stop when at least fifteen distinct private questions qualify, or report the remaining blocker. Do not publish automatically or claim broad-domain coverage from a narrow source set.

For this continuation, the known historical cost is 12 cents in the retained evaluation ledger plus an 11-cent external prior pilot. The 500-cent new-continuation ceiling has 488 cents remaining; the provisional next evaluation subcap is at most 100 cents, not dispatch authority. Preserve that external historical record and subtract it, together with other known usage, before selecting new run caps; do not fabricate provider requests or reset a database to erase it. A bounded combined continuation cap such as 500 cents leaves room under the daily/monthly ceilings, but neither this example nor a new database certifies account-global usage. Never reuse closed v1/v2 run authorizations. Preserve the original fixed expiry and named injected secret source in any conditional preflight. Do not extend expiry or claim account/project identification from a secret-source name.

The public tests use only invented non-curriculum snapshots and mocked actual SDK transport with real guarded local SQL/HTTP services. They prove implementation boundaries, not source truth, model quality, or fifteen real qualified questions.
