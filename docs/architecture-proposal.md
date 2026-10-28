# Architecture and gaps

**Draft recommendation, not implementation approval.** [Start here](README.md) for the reading guide and approval decisions. All “PDF” citations refer to the [unchanged specification](swe-trainer-implementation-specification.pdf).

**Historical baseline:** MVP 1 code and the [root README](../README.md) supersede this document's original “future paths” and setup observations. [Issue #9's specification](automated-content-feedback-spec.md) proposes an amendment to gap 4 only; the active human-content runtime gate is not changed by these documents.

## 1. Keep one application with clear responsibilities

PDF p. 7 already chooses Next.js App Router, server-only route handlers/services, Supabase, and server-side OpenAI. The proposal makes those boundaries explicit rather than replacing the stack.

- **Browser interface:** renders the question, collects the answer, displays save/grading states, and keeps local recovery copies. The browser is not trusted to award a score or choose a user identity.
- **Route handler:** receives an API request. It verifies identity, validates input, checks limits, calls a service, and translates the result into a response. Keep it thin: it should not contain the review algorithm.
- **Application service:** coordinates a task such as “submit answer” or “finalize grade.” It controls database transaction boundaries and calls adapters.
- **Domain code:** implements learning rules such as review graduation, timer calculations, and accuracy metrics. Keep these as pure functions: the same inputs give the same outputs without network or database access.
- **Database adapter:** reads and writes Postgres records. An adapter translates between the application's types and an external system.
- **AI adapter:** sends bounded requests to OpenAI and validates returned data. It cannot directly award mastery or run instructions found in a learner answer.

Why this shape:

- Putting everything inside React components is initially quick, but makes retries, secrets, and shared rules difficult to control.
- A separate backend or microservices allow independent deployment, but add network failures, deployment work, and duplicated contracts without a demonstrated need.
- A modular monolith keeps one deployment and testable internal rules. The trade-off is discipline: imports must respect the boundaries. It is not an excuse for a single large service file.

### Proposed module ownership

These are future paths, not existing code or instructions to create them in this PR. They refine the PDF p. 13 skeleton.

- `app/` owns Next.js pages, layouts, and API route handlers.
- `components/` owns reusable accessible display and input components.
- `lib/domain/` owns scheduling, timing, and analytics functions.
- `lib/server/services/` owns authenticated workflows and transaction coordination.
- `lib/server/db/` owns Supabase clients, queries, and persistence interfaces.
- `lib/server/ai/` owns OpenAI calls and versioned prompts.
- `lib/contracts/` owns safe shared request/response schemas. It must not export secret rubrics.
- `supabase/migrations/` owns versioned SQL schema, privileges, policies, and transactional functions.
- `tests/` owns unit, real-database integration, browser-workflow, and versioned evaluation-fixture tests. Machine-authored cases must not be called independent human gold.

Dependency direction: pages/routes call services; services call domain functions and adapters; domain functions import neither Next.js nor either provider SDK. Browser code may import safe shared contracts, never `lib/server/`. SQL constraints remain the last defense against invalid concurrent writes.

### Data flow for one answer

1. Supabase Auth signs the learner in. Authentication means verifying identity; authorization means checking access to a particular record.
2. The server verifies the current request's identity and loads only the learner's allowed session state.
3. The server returns a public question representation without its private rubric or reference answer.
4. The browser sends draft checkpoints and timing events. The server acknowledges the committed version.
5. Submit stores one immutable attempt plus recoverable grading work, before any AI call.
6. The AI adapter grades against the frozen question/rubric version. Runtime validation rejects malformed output; it cannot establish that the reasoning is true.
7. A short database transaction selects the grade revision and updates derived learning state together.
8. The interface reads durable status and shows the result, or an honest pending/failed/uncertain state.

### Identity, RLS, and private content

**Existing requirements:** per-user isolation, server-only privileged keys, and no rubric leakage (PDF pp. 7–11).

**Proposed defaults:**

- Use a request-specific Supabase server client with the signed-in user's authorization. Verify claims/identity with the official server-auth flow; do not trust an unverified cookie or `getSession()` alone.
- Keep RLS policies on every user-owned table. RLS means that Postgres checks which rows this identity may read or change, even if a route makes a mistake.
- Do not run ordinary requests with a privileged service key. These keys can bypass RLS. A server-only key is still dangerous if the code uses it to read somebody else's records.
- Restrict grade, mastery, and progress writes to the finalization service. An authenticated learner must not be able to write their own score through Supabase's data API.
- Separate private rubric/reference-answer access from the public question representation through database privileges and server projections. RLS filters rows, not automatically secret fields inside an allowed row.
- A recovery invocation has no browser user session. Authenticate the scheduler, load the work item's owner from the database, and permit only its narrow finalization operation. Keep elevated credentials inside that adapter; never accept a worker's `user_id` from an untrusted client.
- Do not cache personalized pages, auth responses, or API data in a shared application shell. A refreshed session cookie must not be replayed to another user by a shared cache.

Use the [official Supabase SSR guide](https://supabase.com/docs/guides/auth/server-side/creating-a-client) and [RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security) for the separately approved implementation. SSR means server-side rendering: preparing page content on the server.

**Acceptance evidence:** real Postgres/RLS tests must show that user A cannot read or modify B's records, that a learner cannot set scores/mastery, and that anonymous/browser access cannot fetch private rubrics. Browser tests must show logout/account switching does not expose prior-user data.

## 2. Gaps and proposed resolutions

### Gap 1: Drafts, offline scope, and timer ownership

**Current evidence**

- PDF p. 2 says “IndexedDB (later).” IndexedDB is storage inside a browser, not a synchronized database.
- PDF p. 3 requires no active draft lost on ordinary device switching.
- PDF p. 7 requires local snapshots, a cached shell plus draft in MVP, conflict-safe versions, and one active timer authority.
- PDF p. 12 AC-15 requires basic draft recovery on connection failure.
- PDF p. 5 says committed state wins and timing comes from timestamps, not browser ticks.

**Missing or conflicting behavior**

The phase for local recovery is unclear. The data model/API do not define server-saved answer drafts. Local storage alone cannot send an unfinished desktop answer to a phone. Two devices can overwrite drafts or count overlapping time without a conflict/ownership rule.

**Practical consequence**

An application can save completed answers correctly but still lose work when switching devices. A “saved” indicator could mislead someone while their edits exist only on one disconnected device.

**Proposed fix — default A1**

- **MVP 1:** add server draft checkpoints and local snapshots for the active text answer. Keep drafts mutable until submit; submitted attempts remain immutable.
- Save locally on edits. Propose server saves after two seconds without typing, at least every ten seconds during continued typing, and before pause/navigation when online. Browser shutdown saves are best-effort; never promise they always execute.
- Keep `baseVersion`, answer text, assistance events, input mode, and question-version identity with each checkpoint. The server validates ownership and exact question version.
- Accept a write only if its expected version matches the committed version. A stale write returns `SYNC_CONFLICT` rather than silently overwriting newer data.
- Preserve both copies on conflict. Show the cloud version and local version, and require the learner to choose; do not attempt automatic text merging in the first slice.
- “Saved to cloud” means the server acknowledged that exact revision. “Saved on this device only” means IndexedDB succeeded but the cloud did not. Show a save failure if neither succeeded. Offer explicit save/retry and last-cloud-save time.
- A second device resumes the latest acknowledged cloud version. It cannot see edits from a first device that has not reconnected.
- Propose one server-granted timing lease per active item: a device's temporary right to record time. Checkpoint at ten-second intervals; expire ownership after thirty seconds without a checkpoint. Another device must explicitly take over.
- Use server timestamps to bound accepted timing segments and validate pause/resume order. A client-supplied `activeDurationMs` is not authoritative. Display elapsed time locally between acknowledgments without counting overlapping segments twice.
- On expiry/takeover, close the prior timing segment at its last acknowledged checkpoint. Reject later timing writes from the old owner. This can undercount the last unacknowledged seconds; it prevents overlapping totals.
- Pause authoritative timing during a detected disconnection. Local offline edits remain recoverable but their timing is provisional and does not silently enter cloud totals. Display that limitation.
- **MVP 3:** add the PWA shell cache and installation. A PWA is a Progressive Web App: a website with browser-supported install/offline capabilities. Cache only non-private shell assets; local drafts remain user-scoped and are cleared on explicit logout/account switching.
- **After MVP:** full offline question sessions and a durable offline submission queue. Until then, show “not submitted” offline and require explicit submission after reconnect. Do not claim offline voice transcription.

**Alternatives and trade-offs**

- Local-only drafts are simpler and protect same-device reloads, but fail the cross-device goal.
- Blind “last write wins” is cheaper, but silently loses concurrent edits.
- Cloud checkpoints plus conflict versions add writes and UI states, but make durability claims testable.
- Rejecting offline timer merges sacrifices perfect disconnected time measurement. It avoids inventing a conflict-resolution algorithm before full offline sessions are in scope.

**Acceptance evidence**

- Proposed browser tests: `draft.cloud-resume`, `draft.offline-local-reload`, `draft.conflict-preserves-both`, `draft.storage-unavailable`, `timer.device-takeover`, and `cache.account-switch-isolation`.
- Checkpoint on desktop, resume at mobile width using a separate browser context signed into the same account, and compare the exact text and committed version.
- Disconnect desktop before more edits: a phone must not claim those edits synced. Reconnect and exercise the conflict choice.
- Advance an injected clock through lease expiry; assert no overlapping timing segments and no increase from stale-owner writes.
- Require a computer-use video showing cloud-save, local-only-save, reconnect/conflict, and cross-device-width resume after the future app builds. No visual proof is claimed by this documentation PR.

**Approval question:** approve A1's phase split, explicit conflict choice, and conservative timer limitation before implementing drafts/timing.

### Gap 2: Recoverable grading and transaction boundaries

**Current evidence**

- PDF p. 8 says to transactionally store an attempt, grade reference, mastery update, and progress.
- PDF p. 9 returns `gradingState: "pending"` and requires failed AI calls not to lose answers.

**Missing or conflicting behavior**

The all-in-one wording does not explain how a slow external AI call fits the transaction or how work resumes after the request/browser ends. A transaction is an all-or-nothing database commit; it cannot roll back a billable network request to OpenAI.

**Practical consequence**

Holding a database transaction open while grading ties up connections and locks. Saving only after grading risks losing the answer. Polling from a browser is a status check, not an executor that survives browser closure.

**Proposed fix — default A2**

- **Transaction 1, submit:** validate the session item and expected version; insert the immutable attempt and persistent grading-work record; mark the item submitted/pending. Commit before contacting OpenAI.
- Scope an idempotency key to the user and operation. Idempotency means replaying that same submission returns its existing attempt, not another attempt.
- Store a canonical request fingerprint. Reusing the key with different content returns `IDEMPOTENCY_CONFLICT`. A different key for an already-submitted session item must not create a second initial submission.
- Use an explicit state machine, meaning named states with allowed transitions: `pending → grading → graded`, `grading → retry_wait → grading`, or `grading → failed/uncertain`.
- `pending` means the answer is saved and waiting. `retry_wait` means a bounded transient-error retry is scheduled. `failed` means no usable grade was produced. `uncertain` means the grader cannot justify a score. Neither is a wrong answer.
- Claim work using an expiring database lease and a revision/generation number. Persist retry count and next-attempt time. The finalization transaction rejects results from a stale lease or superseded generation.
- Run OpenAI outside database transactions. Validate the result and apply the rubric's pass rule in trusted code, rather than accepting a contradictory model `passed` flag.
- **Transaction 2, finalize:** append a grade revision, select its effective status, update/recalculate mastery and analytics inputs, mark grading work complete, and update graded progress atomically. “Submitted” and “graded” counts are separate.
- The original route may attempt immediate grading within a bounded deadline. A browser may poll durable status. Neither is the sole recovery owner.
- **Deployment decision:** propose the host's managed scheduler invoking an authenticated reconciliation handler in the same application at least once per minute for an initial private beta. It claims pending, due-retry, and expired-lease work in bounded batches. This uses persistent state and a managed trigger, not a new custom queue service.
- Confirm the selected host/plan supports that frequency, security, and sufficient function duration for the chosen model. Vercel or a comparable host is permitted by PDF p. 2; its free tier is not assumed sufficient.
- If those limits fail, select a provider-managed durable execution facility before affected implementation. Do not invent a custom queue or assume that a detached promise continues after a serverless request ends.
- The application grading service owns retries. Disable OpenAI SDK automatic retries for this workflow with `maxRetries: 0`; routes, SDKs, and host recovery must not run independent retry loops.
- Propose at most three outbound provider requests per grading generation, including any repair call. Before each dispatch, atomically record its request count and reserve its maximum estimated cost against the same application retry/spending budget. Host recovery resumes this persisted policy; it does not reset the budget.
- Use retry delays of 30 seconds then two minutes for timeouts/rate-limit/transient server errors, honoring a longer provider retry delay. Recovery leases must exceed the configured AI-call deadline. Invalid output gets at most one repair within the same three-request budget; authorization/configuration failures fail immediately.
- Give the learner an explicit retry action after exhaustion. It creates a new grading generation for the same attempt, subject to spending limits, not a new answer.

**Alternatives and trade-offs**

- A single synchronous request is simpler, but provides no browser-independent recovery guarantee.
- A provider-managed executor can improve latency/durability but adds provider choice, cost, and operational setup. Select it only if the host-managed sweep is insufficient.
- Retry-safe database effects are achievable through constraints, leases, and atomic finalization. “Exactly once” AI execution is not promised: a network timeout can hide an already-completed provider call, and retries may incur another charge.

**Acceptance evidence**

- Proposed real-database tests: `submit.same-key-same-attempt`, `submit.key-payload-conflict`, `submit.double-click-concurrent`, `grading.atomic-finalize`, and `grading.stale-lease-rejected`.
- Inject termination after Transaction 1; close the browser. The managed recovery trigger must eventually grade or persist a visible terminal failure without losing the answer.
- Inject an OpenAI timeout and a database failure after the AI response. Repeat finalization and assert one effective revision per generation and one set of derived effects.
- Proposed `grading.single-retry-owner-budget` must count outbound requests, including repairs and recovery after termination: no generation can dispatch more than three, SDK retries are disabled, and every dispatch has a cost reservation.
- Verify execution-limit, scheduler-frequency, and authentication behavior in the selected deployment environment. A polling-only test does not satisfy this criterion.
- Require a computer-use video of pending, refresh, failure, and successful retry once a buildable UI exists.

**Approval question:** approve the two-transaction contract; choose a compatible host/execution option before promising automatic recovery.

### Gap 3: Grade revisions, uncertainty, and relapse

**Current evidence**

- PDF p. 5 permits “uncertain” and regrading.
- PDF p. 8 requires immutable grade revisions and identifies a current grade.
- PDF pp. 10–11 describe mastery updates, not corrections to earlier outcomes.
- PDF p. 10 resets the streak after a graduated question fails, but its pseudocode retains `first_missed_at`.
- PDF pp. 4–5 distinguish vocabulary assistance from conceptual correctness.

**Missing or conflicting behavior**

There is no rule for reversing an incorrect old grade's effects. An old first-miss timestamp could let a newly failed graduated question graduate again without a new 30-day window. A pending or uncertain result could accidentally be treated as `passed = false`.

**Practical consequence**

The same answer history can produce different dashboards depending on which retry/regrade ran first. A learner can receive an undeserved streak reset or an unjustified graduation.

**Proposed fix — default A3**

- Keep submitted answers and grade revisions immutable. A correction adds a revision; it does not edit the old score.
- Keep an auditable effective-grade selection with previous revision, new revision, reason, and time. “Current” means selected, not simply the last response to arrive.
- During regrading, retain the existing scored revision as effective and show “regrade pending.” A failed/uncertain regrade does not silently erase a valid prior grade. With no valid effective grade, exclude the attempt from scored denominators and mastery transitions; show it as unscored.
- Permit explicit invalidation of a flawed grade/question. Record the reason and select an unscored result while review is outstanding.
- Recalculate affected canonical-question mastery, skill estimates, and analytics from effective grades in original submission order, with an immutable ID tie-breaker. Regrading uses the original answer/assists and referenced question/rubric, not a newly generated question.
- Version the recalculation rules. Persist scheduling inputs/jitter choices so replay does not randomly move due dates on every retry. Jitter means a small random variation in scheduling intervals.
- Lock/serialize updates for the affected learner and mastery lineage during finalization/recalculation. Publish the corrected projections atomically; do not increment counters a second time.
- A **review episode** starts with the first scored failure and ends at graduation. Keep its own `first_missed_at`, streak, and graduation record.
- Within an episode, every scored incorrect answer resets the streak. Only correct, unassisted review responses increment it. Correct assisted responses leave it unchanged. Pending, failed, and uncertain grades neither reset nor increment it.
- A new scored failure after graduation starts a new episode with a new first-miss time. Keep the prior episode and original failure in history; do not overwrite them.
- Proposed time interpretation: require 30 elapsed 24-hour days from that episode's first miss, measured in UTC, **AND** ten consecutive unassisted correct review responses to the same mastery lineage. A local calendar-date change alone does not satisfy the minimum.
- A neutral, reviewed pre-session vocabulary primer is preparation, not an in-question assist. Revealing a definition or hint while answering is an assist. Record term lookup and conceptual hint as distinct events.
- A definition-assisted correct answer can still pass the concept rubric. It does not advance the unassisted graduation streak. Vocabulary practice updates the separate vocabulary track.
- Freeze the question/rubric version at exposure. A material concept change starts a new mastery lineage unless a separately approved migration explicitly maps old evidence.

**Alternatives and trade-offs**

- Increment-only counters are easy but cannot repair history reliably.
- Replaying effective grades costs more queries and needs deterministic rules; it yields reproducible corrections and auditability.
- Retaining the original first miss across every relapse allows faster regraduation. A new episode is more conservative and better tests durable relearning, but is a deliberate product change requiring approval.

**Acceptance evidence**

- Proposed unit tests: `mastery.day-29-ten-correct-not-graduated`, `mastery.day-30-nine-correct-not-graduated`, `mastery.day-30-ten-correct-graduated`, `mastery.wrong-resets`, `mastery.assisted-correct-unchanged`, and `mastery.unscored-neutral`.
- Proposed correction tests: `regrade.fail-to-pass-replays`, `regrade.pass-to-fail-replays`, `regrade.uncertain-keeps-prior-score`, `regrade.invalidated-excluded`, and `mastery.relapse-new-episode`.
- Compare incremental finalization with a full replay of the same effective history, including out-of-order AI completions. Assert identical streaks, readiness inputs, and due dates.
- Separate vocabulary assistance, first-attempt accuracy, review retention, and concept outcomes in fixtures and displayed metrics.

**Approval question:** approve episode-based relapse, elapsed-day interpretation, primer/assist classification, and effective-grade correction rules before implementing mastery.

### Gap 4: Trustworthy content and a small grading baseline

**Current evidence**

- PDF p. 10 originally requires human-reviewed “golden” attempts. The requester now rejects mandatory human content pre-review to avoid seeing answers before attempting questions.
- A1–A6 were approved in PR #2. Issue #9 proposes a focused amendment to A4.
- Current MVP 1 still has five candidate questions, private rubrics, and 25 unreviewed example assessments. Its runtime enforces the original content/evaluation gates.
- `components/grade.tsx` displays generated `grade.details.idealAnswer` as “Reference reasoning,” not necessarily the canonical reference in `private.rubrics`.

**Missing or conflicting behavior**

The human-review prerequisite conflicts with the requester's learning workflow. The code has no source-backed qualification/import pipeline, current-only paged catalog, vocabulary persistence, instructional dialogue, or correction proposal/publisher boundary.

**Practical consequence**

Simply removing an approval flag would expose unqualified content without fixing correctness, provenance, version safety, or learner feedback. Valid output and model agreement do not establish truth.

**Proposed amendment — A4, pending human specification approval**

- Use the [automated-content and post-grade learning contract](automated-content-feedback-spec.md) for all new content and requalification of seeds. It specifies schema/API boundaries, lifecycle, budgets, and acceptance cases.
- Author original rights-cleared content. Check claim evidence, execute bounded tests where valid, and use a separate adversarial critic and machine-authored fixtures.
- Permit public interview banks such as LeetCode as discovery/context references for coverage, patterns, and skills, with recorded source URL/provenance. Keep authoritative correctness evidence separate. Reference-domain approval does not authorize fetching, copying, close paraphrase, or importing third-party material; any reuse must meet its terms/license or obtained permission and attribution requirements. This documentation performs no ingestion.
- Quarantine unsupported, disputed, invalid, or over-budget items. Permit bounded revision, then discard. Do not require human answer-key review as fallback.
- Target forty questions/60–80 terms, in batches of at most ten questions, across eight PDF domains. Later target 120 questions/150–200 terms. These are coverage targets, not calibration.
- Publish new immutable versions through a narrow automated publisher. Keep only current qualified content selectable, with replay-safe imports and paging beyond 100. Preserve exact historical versions.
- Add conversation about specific feedback and the submitted reasoning. Pin the effective grade and distinguish generated example answers from canonical references.
- Accept optional owner-scoped correction proposals. Validate the full bundle before global publication; preserve past grades. Do not silently regrade or pretend original-rubric retry applies a corrected version.
- Keep readiness provisional and preserve independent privacy, spending, release evaluation, deployment, and engineering approvals. This documentation does not change any runtime flag.

**Alternatives and trade-offs**

- Human-reviewed seeds provide an independent check but spoil the requester's learning and restore the rejected bottleneck.
- Unchecked generation provides breadth but lacks evidence and correction controls.
- Automated qualification supports learning without mandatory pre-review but retains correlated-model risk. Neither fixtures nor critic agreement prove factual truth.
- Prospective corrections preserve reproducibility. Cross-version regrading needs its own compatibility/audit contract and is deferred.

**Acceptance evidence**

- Use the [new validation criteria](automated-content-feedback-spec.md#validation-criteria): evidence/rights and critic failures block publication; replay-safe imports and concurrent corrections preserve versions; paged catalogs and owned history stay accessible.
- Test premature/cross-user disclosure denial, specific-feedback context pinning, persisted follow-ups, proposal authority, revocation, shared budgets, and unchanged grades.
- Require computer-use video of the future learning/correction flows after a successful build. No feature, paid evaluation, or UI verification is claimed by this documentation.

**Approval question:** approve the [focused decisions](automated-content-feedback-spec.md#human-approval-requested), including automated publisher authority and prospective-only corrections. Review the pipeline, not answer keys. Implementation and live use need separate authorization.

### Gap 5: The container is not yet an app-development contract

**Current evidence**

- [Dockerfile:2–6](../.devcontainer/Dockerfile#L2-L6) installs Ubuntu/Python and general tools, not Node.js, npm, or Supabase tooling. [Line 17](../.devcontainer/Dockerfile#L17) uses `pixi:latest`; [lines 23–26](../.devcontainer/Dockerfile#L23-L26) grant passwordless sudo.
- [devcontainer.json:2](../.devcontainer/devcontainer.json#L2) and [lines 9–14](../.devcontainer/devcontainer.json#L9-L14) assume a WSL/Podman-oriented host, `keep-id`, host networking, a TUN device, and NVIDIA GPU access.
- Its [lines 21–24](../.devcontainer/devcontainer.json#L21-L24) list Python editor extensions, while [lines 27–34](../.devcontainer/devcontainer.json#L27-L34) bind personal SSH/projects/Windows-drive paths and persist agent/editor state.
- README previously contained only the repository title. PDF p. 13 expects npm scripts, setup instructions, and a local database workflow.

**Missing behavior**

The checked-in image does not declare the application runtime or reproducible package installation. Host-specific devices and paths are not a portable prerequisite for a web application.

These are static file observations. No container build or runtime test was attempted. The container may be useful on its author's machine; this draft does not claim it is broken everywhere.

**Practical consequence**

Another machine can fail before the project opens, or open without the tools needed to run the app. `latest` can change without a repository change. Broad writable mounts expose host files and credentials to processes inside the container; passwordless sudo increases the authority of those processes.

An editor extension supplies editing assistance. It does not install the Node runtime that executes JavaScript or the Supabase services needed for database tests. Node and npm might exist incidentally in some environment, but they are not declared here.
Docker and Podman run containers: isolated environments with declared tools. WSL means Windows Subsystem for Linux. `keep-id` maps the host user's file identity into a container; TUN is a network-tunnel device; host networking shares the host's network namespace instead of isolating it. SSH, or Secure Shell, credentials can grant access to other machines or repositories. Sudo permits elevated system commands. These are host/security choices, not prerequisites implied by an editor extension.

**Proposed fix — default A5, for a later change only**

- Declare one supported Node LTS version and compatible npm version. Pin the chosen image/tool versions and commit `package-lock.json`; use `npm ci` for repeatable installation.
- Resolve compatibility across Next.js, React, TypeScript, Tailwind, Zod, Vitest, and the chosen browser-test tools before pinning. Do not guess versions from the PDF date.
- Use the official Supabase CLI with a supported Docker-compatible runtime to run local Postgres/Auth and apply the same migrations as hosted environments.
- Document whether the database runs on the host or in sibling containers. Propose host-managed local Supabase first; verify the devcontainer can reach it without casually exposing a privileged container socket.
- Test Docker and the intended Podman API-compatible workflow explicitly. Do not assume all Podman flags or nested-container setups work on every host.
- Keep personal Python/Pixi/Copilot/Codex tooling optional and separate from app prerequisites. Pin Pixi if retained; it is not the proposed JavaScript package manager.
- Make GPU/TUN access, host networking, personal directory mounts, and SSH exposure opt-in. The Next.js/Supabase/OpenAI web app does not require a local GPU.
- Prefer workspace-scoped mounts and the least credentials needed. Document the security trade-off if a personal setup retains broader access or passwordless sudo.
- Provide future setup instructions, placeholder-only `.env.example`, database reset/seed steps, and an explanation of which tests make paid calls.

**Alternatives and trade-offs**

- Preserving one personal all-purpose container is convenient for its owner but harder to reproduce and audit.
- A smaller app-focused baseline plus optional personal overrides adds documentation but separates project needs from host preferences.
- A shared remote development database reduces local setup, but invites test collisions and weakens reproducibility. Use local isolated databases for integration tests.

**Acceptance evidence**

- In a separately authorized environment PR, build the container from a fresh checkout with no personal host directories, GPU, or TUN device.
- Record `node --version`, `npm --version`, and the Supabase CLI version; run the lockfile install and all proposed gates.
- Apply all SQL migrations and seeds to an empty local Supabase database; run two-user RLS and transaction tests against real Postgres.
- Exercise the intended Docker/Podman connection path and document any supported-host limitation.

**Approval question:** approve the app-focused baseline and optional personal tooling before changing the container. This documentation PR must preserve both existing container files.

## 3. Boundaries of this proposal

- [Gap 6 and concrete standards](stack-and-standards.md#gap-6-package-choices-and-coding-standards) complete the package/tooling decisions.
- No schema, route, service, container configuration, package manifest, or Factory definition is created by this PR.
- Proposed tests are acceptance contracts for future work. They do not exist and have not passed today.
- Each future user-facing change requires a successful build, automated checks, and computer-use visual proof. Prefer video for interactive recovery flows; use screenshots only for genuinely static rendering.
- Human approval must resolve the proposed PDF amendments before affected implementation. A later implementation request should choose one small slice, not interpret this document as an implementation checklist.
