# Automated content and post-grade learning

**Status: proposed product and technical contract for human approval. Documentation only.**

Work item: [issue #9](https://github.com/dhruvapathak-personal/sweprep/issues/9). Inspected base: `86ab16c95b8146a91a6b884b9285df07e894a210` on `main`.

## Summary

Expand the question and vocabulary bank without requiring the learner to inspect answer keys. Qualify original, source-backed content with automated checks and a separate critic. After grading, let the learner ask conversational questions about specific feedback and propose corrections. Publish accepted corrections as new versions. Keep historical answers, grades, and dialogue intact.

This document contains no question content, answer keys, or private rubrics. It does not publish content, authorize paid calls, change runtime approvals, or authorize implementation.

## Confirmed intent and approval boundary

- The requester wants useful learning content now, not a bank limited to five or fifteen questions. Fifteen is the PDF's default session length, not a bank limit.
- No generated question, rubric, fixture, term, or initial seed requires human content pre-review. Voluntary review after an attempt is welcome, not a publication gate.
- Clarification is instructional dialogue about the submitted answer and the evaluator's actual feedback. It is not only a score tooltip, a generic reference explanation, or an appeal.
- The learner can ask why a specific claim was marked wrong or partial, identify a missing assumption, and request examples and follow-up explanations.
- The separate request to correct reference answers remains in scope.
- The requester permits public interview banks such as LeetCode as preparation references. Use them for discovery, coverage, problem-solving patterns, and intended skills, not as automatic correctness evidence or permission to reproduce third-party content.
- A1–A6 were approved in [PR #2](https://github.com/dhruvapathak-personal/sweprep/pull/2#pullrequestreview-5645597629). This proposal amends A4 and the PDF's mandatory human-gold requirement. It does not reopen unrelated decisions.
- The latest request authorizes preparation of this first-pass design, not implementation. Approval of this document must precede affected implementation. Privacy, spending, deployment, and engineering approvals remain separate.

## Product behavior

### P1. Bank size, coverage, and delivery

1. Target an initial **40 qualified questions and 60–80 qualified terms**, released in batches of at most ten questions with linked terms. Then target **120 questions and 150–200 terms**. These are total-bank targets, not additions, calibrated sample sizes, cost estimates, or promised delivery dates.
2. Cover all eight PDF section 3 domains: C++; Python; data structures/algorithms; concurrency/OS; hardware/performance; networking/data; distributed systems; engineering/Principal.
3. Aim for five questions and at least five linked terms per domain in the initial bank. Favor Explain, Predict, Debug, Compare, Design, and Critique. Do not fill a quota with unsupported items. Publish a smaller qualified batch and report the shortfall.
4. Track stable primary and optional secondary skills, category, language/runtime assumptions, prerequisites, term links, and author-estimated difficulty. Label difficulty uncalibrated. Keep architecture/leadership evidence distinct from recall.
5. Show only current, qualified, non-revoked questions for new study. Support paging and domain/category filters beyond 100 records. An empty bank explains that nothing has qualified; it does not fall back to candidates.
6. Retain the existing one-question study loop during expansion. Content and usable catalog work can ship alongside MVP 2. Do not require the full adaptive planner, fifteen-question sessions, or dashboards first.

### P2. Vocabulary without concept-score contamination

1. Persist stable term identities and immutable definition versions. Store formal definition, intuition, neutral example, source evidence, and links to exact question versions.
2. Qualify terms under the same provenance and critic policy. Qualify each question-term link for spoiler risk; a safe standalone definition can still spoil a particular question.
3. Permit only links marked `pre_attempt_safe` in a future primer or inline lookup. Keep solution-specific context post-grade. Revalidate links when either version changes.
4. MVP 2 consumes these records for primers, lookups, and practice. This spec defines storage and integration boundaries, not a new adaptive vocabulary algorithm.
5. Persist user-owned term exposure/lookup events separately from concept outcomes. An in-question lookup sets an irreversible assist on that item before returning the definition. A neutral pre-session primer does not. Post-grade dialogue does not rewrite the submitted assist flag.
6. Term lookup is not evidence of vocabulary mastery. Future vocabulary practice writes its own attempts and projections. It must not award concept success, increment the unassisted review streak, or inflate first-attempt accuracy.

### P3. Clarification as a learning conversation

1. After the release gate below, show **Ask about this feedback** next to grading rationale and feedback claims. Show **Ask about this answer** next to the displayed reference material.
2. A learner can select a strength, missing claim, incorrect claim, or rationale paragraph. The composer quotes the selected stored feedback and accepts a free-text question. General follow-ups about that assessment are also allowed.
3. Explain using the submitted answer, pinned assessment, question assumptions, and permitted source-backed material. Discuss why the learner's reasoning was wrong or partial and offer examples that repair understanding. Use stored learner-facing rationale, never a model's hidden internal thinking trace.
4. Persist multiple turns and restore them after reload or another-device sign-in. Each thread shows the question version, rubric version, grade revision, and clarification target.
5. Distinguish **Evaluator's example answer** (`grade.details.idealAnswer`, currently called “Reference reasoning”) from **Canonical reference answer** (`private.rubrics.reference_answer`). Do not claim they are identical. Present the frozen canonical reference in a separate post-gate disclosure.
6. The reference composer identifies which text it explains. Neither selecting a target nor asking “change my score” changes a grade.
7. A reply can acknowledge a possible evaluator/content mistake and offer the separate correction or explicit original-version grading-retry action. It must not claim a correction is accepted, a score changed, or a source was checked unless that event occurred.
8. Show queued, responding, complete, unavailable, budget-blocked, and failed states. Keep saved turns on failure. A retry uses the same operation identity; it does not duplicate a turn or reset its request budget.

**Release gate**

- Require an authenticated owner, an immutable submitted attempt, and an effective selected grade with `outcome = scored`.
- Initial pending, grading, retry-wait, failed, uncertain-only, and invalidated-effective attempts do not unlock canonical reference access or new clarification threads.
- A prior scored grade retained during pending/failed/uncertain regrading remains eligible. Pin to that selected scored revision, not the latest generation.
- Simulated results can exercise the interface only in the existing isolated local simulation environment. Label dialogue synthetic and exclude it from learning evidence.
- Enforce the gate on the server for every disclosure, thread creation, and new turn. Hidden buttons are not authorization.
- Existing saved dialogue stays readable by its owner when the effective grade changes, with a “Historical context” label. Reject new turns with `CONTEXT_CHANGED` and require a new thread against an eligible selection. Do not silently repin.

### P4. Learner corrections are proposals

1. After the same release gate, show **Suggest a correction** for canonical reference text or the evaluator's example answer. Permit a feedback/rationale dispute from the feedback panel.
2. Collect edited text, a reason, and at least one source locator or reproducible evidence description. Show the exact target/version before confirmation. A proposal is not a write to the rubric.
3. Show private status and a safe explanation: received, checking, quarantined, rejected, published, resolved locally, or superseded. Expose no other learner's answer or proposal.
4. Canonical proposals enter automated qualification. The publisher reconstructs a candidate from trusted stored content and the proposed change. It checks the whole dependent question/rubric/term/fixture bundle, not only the edited sentence.
5. A mistake confined to a generated example answer or rationale appends an owner-only explanatory addendum linked to that grade. It never overwrites `attempt_grades`. If evidence also disputes canonical content, create a linked canonical candidate and run full qualification.
6. “Resolved locally” means a separately validated explanatory addendum, not a new grade or global release. If it cannot be justified, quarantine or reject it.
7. Accepted global corrections create new immutable question/rubric versions and an audited publication event. Past attempts, effective grades, and threads retain their original versions. Show “A newer content version is available; your historical grade is unchanged.”
8. Do not automatically regrade old attempts. Existing **Request a grading revision** retries the original frozen rubric. Label that limitation clearly. Applying a corrected rubric to an old answer is deferred, not simulated by chat or the retry button.

## Technical design

### Current implementation and change surface

These references describe existing code, not completed features from this proposal:

- `components/grade.tsx:14–24` resolves the effective grade; `:53–105` renders rationale and generated `idealAnswer`; `:108–125` offers retry/history. Extend it with claim anchors, target labels, canonical disclosure, dialogue, proposal status, and version notices.
- `components/trainer.tsx` selects from `state.questions` and also uses it to resolve active/history versions. Decouple catalog pages from pinned active/history content. Replace stale five-candidate notices only when the new path works.
- `app/api/study/route.ts:23–30` checks origin/identity before validation. `lib/server/services/study.ts:23–62` dispatches start/checkpoint/submit/retry. Preserve these boundaries.
- `lib/contracts/study.ts:28–79` has no feedback actions; `:132` caps catalog size at 100. Use separate bounded catalog and dialogue contracts, not unbounded study-state payloads.
- `supabase/migrations/202610250001_core.sql:18–37` stores candidate/approved versions and private canonical references; `:203–207` forbids content/history mutation; `:224–240` grants read-only learner access. Preserve these invariants with new migrations.
- `public.start_study` accepts any existing version. `202610250003_state.sql:20` returns the first 100 versions without current/approved filtering. Update direct database/API access, not only the UI.
- `public.retry_grade` at core migration `:355–368` creates a generation for the same attempt. `public.claim_grading` and `public.finalize_grade` in `202610250002_grading.sql` reload its original rubric. `private.recalculate_review` replays effective grades in submission order. There is no cross-version regrade contract.
- `lib/server/env.ts:57–67`, `lib/server/ai/grader.ts:109–112`, and `lib/server/services/recover-grading.ts:36–38` require current approvals and approved content. This PR does not alter them.
- `scripts/generate-seed.mjs:7–35` is a positional five-seed generator, not a replay-safe importer. Existing candidate fixtures are not independent gold labels or automatically qualified.

### T1. Automated qualification and evidence

Use server-only authoring, checking, and publishing services in the existing modular monolith. Do not add an AI tool with database-write authority.

1. **Plan:** choose a coverage gap and stable skill ID. Create an idempotent generation job with policy/model/prompt/schema versions and persisted request/cost allowance.
2. **Ground:** distinguish discovery references from correctness evidence under the source-role policy below. Public interview banks such as LeetCode may inform coverage, patterns, and skills. Ground technical claims in authoritative documentation, standards, original papers, and applicable executable evidence. Record source URL/document ID, role, locator, edition/runtime, access time, and provenance; record digests and rights/license basis for material retrieved or reused. Missing required correctness evidence or permission for reproduction blocks qualification.
3. **Author:** write independent original scenarios, explanations, examples, and tests. Reference-only use of interview banks is allowed; copying or close paraphrase of statements, editorials, solutions, examples/tests, or datasets is not the default. Any reproduction/import requires applicable terms/license or obtained permission and required attribution. The requester's permission to reference a bank does not grant third-party reuse rights. Map required rubric claims and material factual assertions to correctness evidence. Design answers must state assumptions, acceptable alternatives, and limits, not one universally correct design.
4. **Check deterministically:** validate schemas, IDs, skills, safe blocks, sizes, pass-rule coherence, term-link exposure, exact duplicates, and role-specific evidence/rights completeness. Compare normalized bank text with a versioned default threshold of 0.85 token Jaccard similarity; quarantine matches rather than auto-merge.
5. **Execute where valid:** test claimed outputs/properties against declared toolchains. Run generated code only in disposable, network-disabled isolation with no credentials, read-only inputs, 5-second CPU/10-second wall limits, 256 MiB memory, and 64 KiB output. Never execute it in the app, DB, or credential-bearing worker. Missing isolation blocks executable qualification.
6. **Respect proof limits:** a passing run cannot establish absence of undefined behavior, all concurrency schedules, portability, or general design correctness. Require source-based checks for those claims. Record “not applicable” with a reason for non-executable material.
7. **Critique separately:** a distinct task/prompt independently attempts the problem, challenges assumptions/alternatives, checks evidence, and detects rubric/spoiler defects. It does not inherit the author's self-verdict. Pin model/configuration. A different model may reduce correlation but does not prove independence or truth.
8. **Evaluate:** a separate fixture-author task creates at least five machine-authored cases per question: wrong, partial, borderline pass, strong, and ambiguous/unscorable. The critic checks their rationale, expected outcome, and explicit score ranges against evidence. Run the pinned grader on all five. Require no expected pass/fail reversals, ambiguous cases unscored, and scored cases within recorded ranges.
9. **Qualify:** require every applicable check to pass and no unresolved critic objection. Record bundle digest and test results. Machine agreement is a consistency check, not ground truth. Do not call these cases human gold or claim calibrated readiness.
10. **Fail closed:** unsupported facts, critic disagreement, test failure, near-duplicates, invalid rights, or grader mismatch quarantine the bundle with reason codes. Permit one revised candidate with fresh checks, then discard from release eligibility. Retain audit metadata. Do not send keys to a mandatory human reviewer.

Default allowance per question lineage: two candidate runs, each capped at twelve provider requests including author, critic, fixtures, evaluations, repairs, and transport retries; at most twenty-four total. Terms allow two runs of three requests each. Each individual task allows at most three requests and one schema repair within its parent allowance. Exhaustion quarantines the item.

Persist counts before dispatch. Disable SDK retries. Use bounded leases with stale-result rejection as grading already does. A crash, import replay, or identical content/evidence resubmission does not reset allowances. A changed evidence/policy revision requires a new audited job and operator-authorized batch allowance, not an infinite automatic loop.

#### Source roles and reuse

- `discovery_context`: public interview-bank references, including LeetCode, can identify coverage gaps, problem-solving patterns, and intended skills. Record the platform, source URL/locator, access time, intended use, and relationship to the independently authored item. Linking or storing that provenance does not authorize storing the source's statement or solution.
- `correctness_evidence`: authoritative technical references and applicable executable results support rubric claims. A bank's popularity, editorial, accepted solution, or example tests alone do not satisfy this role. Discovery references do not replace claim-to-evidence mappings.
- Keep source-role permissions distinct from fetch/reuse permissions. An approved reference domain is not blanket permission to retrieve, scrape, import, or reproduce its content. A reference-only record may contain URL/provenance without a stored source payload.
- Before any later fetch or reuse, check applicable terms, license or obtained permission, permitted access method, and attribution requirements for the specific material and use. Missing permission for copying or close paraphrase quarantines that candidate; it does not prohibit an otherwise independent question from citing the bank as a discovery reference.
- This revision performs no scraping, access-control/paywall bypass, content ingestion, or reproduction. Future source adapters must enforce their role-specific access and reuse policy; they do not acquire those permissions because this design allows references.

### T2. Publication, revocation, and schema boundaries

Add migrations; do not rewrite deployed migrations or mutate candidate/approved content.

- `private.content_candidates`: immutable bundle revisions, stable lineage ID, parent/base version, payload/evidence digests, skill/category metadata, and origin (`generation`, `seed`, `correction`). Unreleased content stays private.
- `private.content_sources` and `private.content_claim_sources`: versioned source/rights records and claim-to-source mappings. Record `source_role` (`discovery_context`, `correctness_evidence`), source URL/locator, intended use, and `use_mode` (`reference_only`, `permitted_reuse`), plus terms/license/permission and attribution basis for reuse. Only correctness-evidence records satisfy rubric claim checks. A reference-only discovery record requires no stored source payload.
- `private.qualification_runs`: candidate digest, policy/model/prompt/toolchain/fixture versions, check results, critic objections, request ledger, and terminal decision. Machine fixtures/full checks stay private.
- `private.content_publication_events`: append-only publish, supersede, revoke, or requalify events with reason, actor/job, qualification ID, and expected parent head. A publisher-derived `current_content` projection tracks the active version per stable identity and catalog revision.
- Published `public.question_versions` retain `content_review = approved`, meaning automatically qualified under the recorded policy, not human-reviewed. Insert the new private rubric and publication event atomically. Never update candidate rows to approved.
- `public.vocabulary_terms`: stable identity/domain; `public.vocabulary_term_versions`: immutable formal definition, intuition, neutral example, version, and qualification reference. Apply the same current/revocation rules.
- `public.question_terms`: exact question-version/term-version pair, required flag, and checked exposure class (`pre_attempt_safe`, `post_grade_only`). Keep solution-bearing text in private versioned context, not public term rows.
- `public.vocabulary_events`: owner, term version, optional item, event kind, timestamp, and idempotency key. Reserve separate future `vocabulary_attempts`/`vocabulary_mastery` for practice; never reuse `review_episodes`.
- `public.clarification_threads`: owner, attempt, question/rubric IDs and digests, grade ID, selection ID, target, optional feedback anchor, context digest, creation, and expiry.
- `public.clarification_turns`: immutable ordered user/assistant messages and operation ID. Store exact provider input in private context records. Keep response state, lease, allowance, and usage in private jobs.
- `public.correction_proposals`: owner, attempt/context IDs, target, immutable edited text/reason/evidence, base head, and idempotency key. Append decision events and owner-only explanatory addenda. Internal critic details/source excerpts stay private.

All owner records need RLS and composite ownership foreign keys. Learners receive read projections and narrow owner-checked submission functions, not direct table writes. Deny anonymous access and learner writes to qualification, publication, decisions, addenda, grades, and mastery. A fixed-search-path publisher function accepts only a qualified bundle ID/digest and expected head, never arbitrary SQL or a caller-supplied approval result.

The automated publisher is a narrow job capability. It may read candidates and publish qualified versions. It cannot read learner answers, set grades, or administer users. An owner-checked intake service converts a proposal into a content-only candidate and strips learner identity and answer/dialogue text. Qualification must reject private/confidential material embedded in proposed replacement text. A clarification worker receives one owner-verified frozen context, not global rubric browsing or publication rights. Keep credentials in adapters; a service-role key alone is not product authorization.

**Version-safe import and publication**

- A manifest identifies stable IDs/versions, evidence/qualification digests, parents, dependencies, and bundle checksum. Dry-run validates it without DB writes or provider calls.
- Replaying an identical manifest is a no-op. Reusing an ID/version with a different digest returns `VERSION_CONFLICT`. Never upsert immutable text.
- Publish a batch atomically after dependencies qualify. Serialize/compare-and-swap each canonical head. Two corrections based on the same head cannot both replace it.
- A losing proposal becomes superseded. Rebase only as a new candidate with full checks and a linked decision; never silently merge edits.
- Existing five candidates need the same pipeline. If qualified, publish new versions with recorded evidence. Do not bulk relabel seeds or assume old fixture expectations are valid.
- Replay checks after source/model/policy changes. An unverified learner accusation cannot remove global content. Revoke a published version only after an objective machine failure or critic-substantiated material correctness/rights defect.
- Revocation appends an event and removes new-study eligibility. Pause affected active drafts with an explanation and explicit restart choice; preserve text/version and timing history. Reject new submissions to revoked content. Never silently switch a draft to its replacement.
- Completed attempts/grades remain readable with a content-warning notice. Revocation does not automatically invalidate grades or replay mastery. Block new paid grading/clarification against revoked content.
- Requalification restores eligibility only through a fresh audited event and passing checks. Keep prior revocation evidence.

Proposal transitions are `received → checking → published/resolved_locally/rejected/quarantined/superseded`. A quarantined proposal can enter one bounded revised check; exhaustion becomes rejected. Publishing and its terminal proposal event commit together. Invalid or abusive user input does not schedule provider work. Worker failures retain the durable checking job and bounded retry allowance, then end quarantined with a safe reason.

For a revoked active draft, add an owner-checked `restart_revoked` study action with `{ key, itemId, expectedVersion }`. Atomically archive the old session/item without editing its text/version/timing, then start the explicitly confirmed current replacement as a fresh item if one exists. No replacement means archive only and return to catalog. Add an `archived` state in a new migration. Duplicate keys return the same result; stale writes conflict. Do not manufacture an attempt or carry answer text/assistance into the new item.

### T3. Catalog and history retrieval

- Add `GET /api/content/questions?domain=&category=&cursor=&limit=` and matching terms listing. Default page 20; maximum 50. Return safe metadata, current version IDs, `qualificationPolicy`, `uncalibrated`, `catalogRevision`, and `nextCursor`. Do not return rubrics, fixtures, or solution-bearing citations.
- Order by stable canonical ID. Bind opaque cursors to filters and catalog revision. A revision change returns `CATALOG_CHANGED` and restarts paging, not silent skips/duplicates.
- Recheck current/qualified/non-revoked status inside `start_study` under the publication lock. Stale choices return `CONTENT_CHANGED` or `CONTENT_REVOKED`.
- Tighten direct `question_versions` reads: allow current qualified rows or exact versions pinned by that user's item/attempt. Remove the current `using (true)` candidate-reading policy.
- Read active/history versions separately by owned item/attempt ID, irrespective of catalog pages or supersession. Keep the existing latest-100 history limit explicitly labeled; a complete history/export redesign is out of scope.
- Expose canonical references through one gated owned-attempt projection, never a generic rubric endpoint. Return only its frozen reference and permitted citations, not hidden fixtures or other keys.

### T4. Clarification and proposal APIs

Add strict Zod contracts in `lib/contracts/feedback.ts`, server-only services in `lib/server/services/`, and adapters in `lib/server/ai/`. Keep browser-safe and private contracts separate. Routes for this slice:

- `GET /api/attempts/:attemptId/feedback`: eligible reference disclosure, safe targets, effective selection, owner thread/proposal summaries, and version warnings.
- `POST /api/attempts/:attemptId/clarifications`: `{ key, expectedSelectionId, target, feedbackAnchor?, question }`. Targets: `grading_reasoning`, `generated_example_answer`, `canonical_reference`. The server loads all substantive context.
- `GET /api/clarifications/:threadId`: owner-only pinned metadata and saved turns.
- `POST /api/clarifications/:threadId/turns`: `{ key, expectedTurn, question }`. Serialize turns; stale order returns `TURN_CONFLICT`.
- `DELETE /api/clarifications/:threadId`: owner-checked payload/context purge and job cancellation; return HTTP 204. An in-flight worker cannot restore deleted text.
- `POST /api/attempts/:attemptId/corrections`: `{ key, expectedSelectionId, target, editedText, reason, evidence }`. Targets match dialogue. The server derives base version and owner.
- `GET /api/corrections/:proposalId`: owner-only events/status, safe reasons, and published replacement/addendum ID.

Return HTTP 202 with operation ID and durable queued state for provider-backed work. Polling reads status; it does not execute work. An authenticated scheduled worker processes jobs independently of the browser under separately approved deployment configuration. Do not expose arbitrary tools or an open-ended agent.
Use UUID keys scoped to owner and operation with a canonical request fingerprint. Replays return the original result; different payloads under the same key return `IDEMPOTENCY_CONFLICT`. Include the initial question as the first turn atomically with thread creation. Bind feedback anchors to a server-issued field/index/text hash of the pinned grade; reject invented or stale anchors. Do not accept quoted feedback from the browser as authoritative.

Capture effective selection and materialized context atomically before dispatch. Pin the submitted answer, rendered question, original rubric, selected grade details, selected claim text/hash, evidence snapshot, and prior turns. Never reconstruct from “latest” content. Recheck ownership, selection, and revocation before dispatch/finalization. If selection changed during an already-dispatched call, store its reply as historical, not current.

Answers, dialogue, sources, and proposals are untrusted data. The clarification model has no tools, URL fetcher, DB writes, or grade mutation interface. Use stored qualified context and acknowledge unsupported questions. Do not provide unrelated keys. Follow-up examples must not disclose solutions to other unattempted questions.

All reads authenticate and check ownership. Browser mutations require the existing same-origin check. Reject supplied `userId`, score, grade result, rubric, approval flag, or model choice. Keep responses `private, no-store`; discard in-flight results on account change as `components/trainer.tsx` already does.

Errors: existing `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `VALIDATION_ERROR` (400), `IDEMPOTENCY_CONFLICT` (409); plus `GRADE_NOT_RELEASED`, `CONTEXT_CHANGED`, `TURN_CONFLICT`, `CONTENT_CHANGED`, `CONTENT_REVOKED`, `CATALOG_CHANGED`, `VERSION_CONFLICT` (409), `REQUEST_LIMIT` (429), `BUDGET_EXCEEDED`/`FEATURE_DISABLED` (503). Missing/foreign objects use the same non-disclosing forbidden response. Never echo private context in errors.

### T5. Abuse, budgets, and privacy

- Inputs: question 2,000 characters; correction text 10,000; reason 2,000; at most five evidence entries of 2,000 characters. Keep the existing 64 KiB total ceiling.
- Evidence locators are text, not instructions to fetch arbitrary URLs. A dedicated source importer checks source role and specific fetch/reuse permission before the HTTPS host allowlist, redirects, public destinations, and time/size limits. An allowed reference host alone grants no fetch or reuse authority. Reject private/loopback/link-local/metadata endpoints. Clarification never fetches user URLs.
- Default to twenty user turns/thread, ten new turns/hour/user, and three proposals/day/user. Deduplicate owner/target/base/digest and serialize in-flight turns. A persisted per-account work allowance prevents proposals from exhausting the batch budget.
- Each clarification turn allows two provider requests including one repair/retry, a 30-second call deadline, and 3,000 output tokens. Cap complete input at 64 KiB. If context cannot fit, stop and offer a new thread; never silently drop the original assessment.
- Generalize the grading-only cost ledger across generation, critique, evaluation, clarification, and correction checks. Reserve maximum cost atomically before every dispatch. Keep ceilings at most 100 cents/day and 2,000 cents/month unless separately approved. Unknown usage retains its reservation. Targets may need several budget windows.
- Pause background authoring at the cap; show blocked states for grading/dialogue. No retry resets counts or bypasses approval/cost limits. Provider alerts do not replace application enforcement.
- Reject/quarantine abusive repeats. Popularity, repetition, learner role, and model consensus are not publication authority. Never inject proposed answers directly into shared grading context.
- Proposed private dialogue retention: 90 days from thread creation, with visible expiry and owner deletion. Purge turns and private context on expiry/deletion; retain only non-content operational counters. This privacy default still needs approval.
- Retain proposal payload/evidence until terminal decision plus 90 days, then remove learner identity/raw proposal text. Shared published content and non-personal provenance/audit metadata remain reproducible. Account deletion removes private payloads, not shared content.
- Run retention cleanup through the authenticated scheduler. Payload purging is an explicit privacy exception to dialogue/proposal immutability, not permission to modify attempts, grades, or published content. A deletion/expiry marker prevents worker finalization from resurrecting purged text.
- Log IDs, safe states, versions, latency, and usage, not answers/messages/proposals/provider bodies/credentials/rubrics. `store: false` is not proof of provider retention. Approve the new payload categories before paid use.

### T6. Runtime gate transition, only after approval and implementation

Current README/code remain the operating contract. Do not set `CONTENT_REVIEW_APPROVED=true` as a shortcut. The later implementation must:

- Replace the human-content flag with fail-closed `CONTENT_POLICY_VERSION` for a deployed qualification policy. Missing/unknown policy forbids new content use/provider dispatch.
- Check matching publication events and passing qualification digests at start and grading dispatch. An `approved` string alone is insufficient. Never grandfather candidates.
- Keep `MODEL_EVAL_APPROVED` as separate release authorization for an exact model/prompt/validator/evaluation manifest. Replace mandatory human-gold evidence with the automated suite. The human reviews pipeline/report/risk, not keys.
- Re-run checks for affected model, prompt, rubric, source, or policy changes. Never overwrite old evaluations or silently weaken mismatch criteria.
- Preserve provider-data and recovery approvals, disabled-by-default modes, independent feature-enable controls, positive budgets, and hosted-simulation rejection.
- Update `lib/server/env.ts`, both grading checks, UI notices, `.env.example`, operator docs, and tests together. Retain active setup instructions until a tested replacement exists.

## Decisions and alternatives

- **Automated qualification versus human-gold seeds:** human review provides an independent check but spoils the requester's learning and is explicitly rejected as a prerequisite. Choose source-backed qualification for every seed/new item. Accept correlated-model risk and label it honestly.
- **Evidence/critic versus voting:** voting adds cost without proving truth. Choose evidence, bounded execution, and an adversarial task; quarantine disagreement. No human-content fallback.
- **Interview-bank references versus exclusion or copying:** excluding banks loses useful coverage/pattern context and conflicts with the requester's clarification. Copying risks unlicensed reuse and inherited errors. Choose reference-only discovery plus independent original authoring, separate authoritative correctness evidence, and explicit rights/attribution checks for any permitted reuse.
- **Automated publisher versus direct edits:** direct writes can poison shared rubrics. Human moderation restores the rejected bottleneck. Choose automated validation/publication with immutable audit and abuse limits.
- **Pinned dialogue versus free-floating tutor:** generic chat loses assessment/version context. Choose persisted feedback-anchored Q&A that can teach beyond a quoted sentence but cannot become a tool-enabled general agent.
- **Scored-effective gate versus submission-only:** submission-only access leaks keys before evaluation. Blocking every pending job hides retained valid results. Choose the existing effective-scored display boundary.
- **Separate canonical disclosure versus relabeling `idealAnswer`:** relabeling is cheaper but falsely treats generated text as the private source of truth. Choose explicit targets and a separate gated canonical reference.
- **Prospective correction versus retroactive regrade:** automatic regrade changes historical evidence and needs compatibility/replay that retry lacks. Choose new content versions and addenda now. Defer cross-version regrading; any later API must require an explicit owner request, audit reason, compatible version mapping, and effective-grade replay.
- **Paged catalog versus raising 100:** a larger constant still truncates and loses historical context. Choose cursor pages plus separate owned historical retrieval.

## Assumptions

Defaults authorized for first-pass drafting, not implementation:

- Equal initial domain targets; later adjustments follow coverage gaps and learner evidence, not invented calibration.
- The automated publisher decides corrections. Quarantine leads to automated revision/discard, not mandatory human key review.
- Dialogue is persisted, version-pinned, effective-scored-gated, and privately retained for 90 days.
- Corrections are prospective; cross-version regrading is deferred.
- Request/retry/similarity/batch limits are conservative initial defaults. Quantities are targets, not proof of quality or a paid-run commitment.

## Phased delivery and out of scope

1. **After spec approval — foundation:** migrations/RLS, provenance/check contracts, repeatable dry-run import, qualified current catalog, exact owned historical retrieval, vocabulary versions/links, and offline tests. No content release as a migration side effect.
2. **First useful release:** qualify small batches, release first ten questions with terms and provisional labels after independent live-use approvals. Run alongside MVP 2, not after full adaptive sessions. Expand to forty as checks/budget permit.
3. **Post-grade learning:** dialogue, explicit reference targets, correction proposals, automated publication/addenda, revocation, and abuse/privacy safeguards. These depend on the foundation, not adaptive selection.
4. **Expansion with MVP 2:** later bank targets; terms in primer/lookups and separate practice; session planning under its own contract.

Excluded: actual content creation/publication in this PR; paid tests; hosted DB changes; runtime flags; new adaptive algorithms; voice/PWA/charts; readiness calibration; arbitrary website ingestion; direct rubric writes; mandatory human moderation; automatic grade invalidation; cross-version regrade APIs; and rewriting attempts.

## Validation criteria

These are required **future** cases, not tests that exist or passed in this PR. Use synthetic non-curriculum fixtures and mocked provider transport in routine CI.

### V1. Content and versions

- `tests/unit/content-qualification.test.ts`: `evidence-required`, `reuse-rights-unknown-quarantined`, `critic-disagreement-quarantined`, `execution-not-proof-of-concurrency`, `similarity-threshold-versioned`, `spoiler-link-rejected`, `fixtures-labeled-machine-authored`, `grader-mismatch-blocks`, `lineage-budget-not-reset`. Assert exact terminal states and no publication on failure.
- `tests/unit/content-qualification.test.ts`: `bank-discovery-reference-accepted`, `bank-provenance-recorded`, `bank-reference-not-correctness-evidence`, `reference-domain-not-fetch-or-reuse-permission`, `unauthorized-reproduction-quarantined`, and `permitted-reuse-requires-attribution`. Use metadata-only synthetic source records, not fetched bank content. Assert that an independent original candidate can qualify with a discovery reference and separate correctness evidence, while unlicensed copied/closely paraphrased material cannot.
- `tests/integration/content.test.ts`: `manifest-replay-no-op`, `same-version-different-digest-conflict`, `publish-dependencies-atomic`, `concurrent-head-one-winner`, `candidates-not-grandfathered`, `revocation-removes-eligibility`, `unverified-proposal-cannot-revoke`. Inject transaction failure; assert no partial rubric/head/event update.
- `tests/integration/catalog.test.ts`: load at least 151 synthetic identities plus superseded/candidate/revoked versions. Require `all-current-pages-reachable`, `no-unqualified-direct-read`, `stale-start-rejected`, `cursor-bound-to-filters-and-revision`, `owned-history-survives-page-and-version-change`. Assert no private references in catalog payloads.
- `tests/integration/vocabulary.test.ts`: `links-freeze-both-versions`, `lookup-assist-atomic`, `primer-does-not-spoil`, `lookup-not-mastery`, `cross-user-events-denied`, `vocabulary-not-concept-success`. Retain the 30-day AND ten-unassisted review rule.
- `tests/integration/content.test.ts`: `revoked-draft-preserved`, `revoked-submit-denied`, `restart-revoked-idempotent`, `restart-without-replacement-archives-only`, `past-grade-unchanged-on-revoke`, `revoked-paid-work-blocked`. Compare row digests, selected grades, and one-active-session constraints before/after revocation and restart.

### V2. Dialogue and corrections

- `tests/integration/feedback.test.ts`: `pre-grade-denied`, `uncertain-only-denied`, `invalidated-effective-denied`, `retained-score-eligible`, `cross-user-every-route-denied`, `private-rubrics-still-denied`. Test routes and direct DB/RPC access, not only buttons.
- `tests/unit/clarification.test.ts`: `selected-claim-and-answer-sent`, `no-hidden-thinking-request`, `generated-and-canonical-targets-distinct`, `follow-up-keeps-pinned-context`, `unsupported-answer-admits-limits`, `injection-has-no-tools`, `unattempted-keys-not-in-context`. Inspect mocked payloads.
- `tests/integration/feedback.test.ts`: `thread-restores-turns`, `selection-change-new-thread`, `context-change-during-dispatch-historical`, `concurrent-turn-conflict`, `same-key-no-duplicate-turn`, `dialogue-never-mutates-score`. Compare attempts/grades/selections/review projections across multiple turns and failure/retry.
- `tests/integration/corrections.test.ts`: `proposal-not-rubric-write`, `full-bundle-check-required`, `generated-only-addendum-not-global`, `unsupported-proposal-quarantined`, `concurrent-correction-superseded`, `accepted-correction-new-version`, `no-retroactive-regrade`. Assert old content/grades/assists/dialogue remain unchanged.
- Retain `tests/integration/study.test.ts` cases “keeps drafts private, rejects direct writes and protects rubric and grader functions” and “preserves prior scored grades during failed/uncertain regrade and replays corrections and invalidation.” Add `retry-still-uses-original-rubric`; never claim retry applies corrected content.
- `tests/integration/ai-budgets.test.ts`: `shared-cap-all-tasks`, `concurrent-reservations`, `repair-counts-once`, `crash-does-not-reset-budget`, `zero-budget-no-call`, `unknown-usage-keeps-reservation`. Missing independent approval blocks dispatch.
- `tests/integration/feedback-privacy.test.ts`: `owner-delete-purges-context`, `expiry-purges-payload`, `inflight-cannot-restore-deleted-text`, `proposal-retention-preserves-nonpersonal-audit`, `account-switch-discards-inflight`, `logs-have-no-text-or-secrets`. Advance a clock and inspect DB, responses, and logs.

### V3. Implementation commands and visual proof

- Run existing `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- In isolated CI only, run documented `python3 scripts/ci/local-stack.py start`, `python3 scripts/ci/local-stack.py prepare-test`, `npm run test:integration:ci`, and type-drift check. No hosted reset or paid provider call satisfies these tests.
- Live qualification/evaluation is a separate opt-in, budget-authorized job. Persist every candidate's source/rights/check results, exact versions, fixture mismatches, request count, and cost. Acceptance requires zero published failures; quotas never override failures.
- After a successful build, require computer-use **video**: select specific wrong/missing feedback, ask why the learner's reasoning was partial, request an example, ask a follow-up, reload, and confirm unchanged score.
- Require video of generated/canonical targeting, correction proposal/status, new-version notice with old grade retained, and failure/budget-blocked states. Use isolated synthetic content and stubbed AI, not hidden curriculum keys.
- Verify desktop/phone widths, keyboard-only operation, visible focus, labeled controls, status announcements, and readable history. Attach recordings to the implementation PR. Static screenshots do not prove these flows.

### V4. This specification PR

- `git diff --check` passes. Changed paths are only `README.md` and Markdown under `docs/`.
- Relative links and referenced current symbols resolve. PDF, runtime, migrations, seeds, fixtures, environment templates, and factory definitions remain byte-for-byte unchanged.
- Check the new spec with the repository's pinned Prettier when available; report unavailable tooling. Do not add app scaffolding to claim a check.
- Do not claim a build, feature test, model-quality evaluation, or UI verification for this documentation.

## Human approval requested

Approve or amend these decisions without reading answer keys:

1. **Automated policy:** no human-content pre-review, including seeds/fixtures/corrections; evidence and critic checks quarantine/revise/discard failures.
2. **Authority:** a narrow automated publisher releases qualified global corrections; learners submit proposals only.
3. **Learning flow:** persisted conversation about specific feedback and submitted reasoning, separate generated/canonical reference targets, effective-scored release gate.
4. **History:** new immutable versions, no chat score changes or automatic retroactive regrade, deferred cross-version regrading.
5. **Targets:** ten-question batches toward forty questions/60–80 terms and later 120/150–200 across eight domains, without waiting for full MVP 2 sessions.
6. **Risk/privacy/cost:** provisional uncalibrated content, bounded retries/abuse limits, 90-day private dialogue retention, unchanged spending ceilings. Provider-data approval for added payloads and deployment approval remain live-use prerequisites.

Record approval against the committed revision. A draft PR, green documentation check, or first-pass acknowledgment is not implementation authorization.
