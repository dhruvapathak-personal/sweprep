# Offline grading and qualification calibration

**Proposed rules, awaiting approval. Docs only.** [Issue #19](https://github.com/dhruvapathak-personal/sweprep/issues/19). Approval concerns policy and design, without inspecting answer keys. It does not authorize implementation, paid calls, DB changes, import, qualification, publication or activation.

## Summary and minimal path

Make the existing reviewer and grader rules precise before another pilot. This spec produces no learner questions. A **fixture** is a test answer and its expected assessment, not another question for the learner.

The failed pilot reviewed and graded pre-existing drafts; it did not generate or qualify them. Four deterministic cases matched. Eleven model calls produced five matches and six mismatches, not six established factual errors. Estimated token cost was $0.047649; the conservative ledger retained $0.11. No learner question was approved.

The minimal future path is: approve these rules; separately authorize a small implementation and offline checks; freeze a revised private evaluation package; obtain separate bounded-run authorization; evaluate; make a release decision. Only a satisfactory evaluation plus independent existing gates can permit later qualification and publication of the existing drafts. New prompt-to-question generation is separate work.

## Required behavior

### 1. Grounding, privacy and originality

- A `quote` must be one nonempty, contiguous, verbatim substring of the pinned source snapshot, including punctuation, whitespace and case. Do not normalize text, join passages or insert ellipses. Retain the source ID, edition, locator and digest.
- A `claim`, independent answer or explanation may paraphrase. The quote must actually support the mapped claim under the stated assumptions; substring membership alone does not prove support.
- Decide factual support, privacy and originality separately. A fact can be supported while its candidate remains blocked by privacy or reuse uncertainty.
- Source reviewer and critic must each assess the supplied candidate, provenance, permissions and source material. Public accessibility does not establish copying rights. Permission to process a snapshot does not establish permission to reproduce it.
- Use `private_or_uncertain` or `reuse_or_uncertain` when the supplied records do not justify a positive finding. State the specific unresolved issue. Neither another reviewer's confidence nor an absence of detected secrets resolves it. Quarantine unresolved cases; do not force a positive label.

### 2. Fixture author and critic

- Every scored fixture must have integer bounds `0 <= minScore <= maxScore <= 5`, a Boolean `expectedPass`, an evidence-backed rationale and exact basis quotations.
- Passing ranges must lie wholly at or above the frozen pass threshold. Failing ranges must lie wholly below it. Do not use nulls or a threshold-crossing range to hide disagreement.
- An uncertain expectation has null bounds and null pass. A grader's uncertain output remains only `{ outcome: "uncertain", reason }`; it has no score or pass field.
- The critic evaluates whether the **expected outcome, bounds and pass rule** follow from the test answer, question, rubric and evidence. It must not reject an intentionally wrong answer merely because that answer is false. It must reject an unjustified expected grade, even when the label says “strong.”
- Keep source review, fixture authoring and critique as separate requests. The grader receives no fixture label, expected score or critic verdict. An unresolved objection or mismatch still blocks qualification.

### 3. Anchored scores and pass rules

Treat each `requiredClaims` entry as an atomic, equally counted critical claim. Check semantic meaning, not keyword matching. Count a claim only when the answer supports it without contradiction. Reject a rubric whose claims overlap, contradict each other or leave acceptable alternatives undefined.

| Score | Anchor                                                                                                                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | No correct relevant claim or meaningful correct fragment. Includes a wholly wrong, irrelevant or non-answer response.                                          |
| 1     | Meaningful correct fragment, but fewer than half of the required claims are satisfied.                                                                         |
| 2     | At least half, but not all, required claims are satisfied.                                                                                                     |
| 3     | All required claims are satisfied, but a material reasoning error remains outside those claims. Identify the error and why it matters to the requested answer. |
| 4     | All required claims are satisfied with no material error. A concise complete answer qualifies.                                                                 |
| 5     | Score 4 plus the rubric's predeclared, question-relevant excellence criterion, such as precise application of a stated boundary condition.                     |

- Missing or contradicted required claims cap the score at 2 and set `criticalClaimsMet=false`. Scores 3–5 require `criticalClaimsMet=true`. Preserve partial credit; one error does not erase valid reasoning.
- Compute pass on the server as `score >= passScore && criticalClaimsMet`. The revised pilot uses `passScore=4`; do not change historical thresholds.
- Record the score-5 criterion in the private reference answer before evaluation. If the question has no meaningful discriminator, explicitly assign 5 to a fully correct answer without extra prose. Do not invent missing requirements during grading.
- Optional detail, stylistic preference and verbosity do not earn or lose points by themselves. A relevant false addition can lower the score only with an identified material error. A contradiction of a required claim follows the cap above.

### 4. Honest uncertainty; narrow amendment

A missing, wrong, vague or evasive answer is gradeable when the supplied assessment context supports a justified score. Do not manufacture uncertainty because the answer is poor. Use uncertainty only when missing or contradictory question, assumptions or rubric context prevents a defensible assessment. Identify the blocking context, not merely low confidence.

**Proposed v2 amendment to [T1 steps 8–10](automated-content-feedback-spec.md#t1-automated-qualification-and-evidence):**

- Each question has five machine consistency fixtures: `wrong`, `partial`, `borderline_pass`, `strong`, `non_answer`. All five are scored. The first two and `non_answer` fail; the other two pass. `non_answer` replaces the forced `ambiguous` fixture.
- Independent release evaluation also requires a separate `uncertain_context` negative control. Give it a schema-valid but semantically insufficient or contradictory assessment context. It must return uncertain with a specific reason.
- Keep that defective control outside candidate intakes and publication. Do not damage a valid learner question to create an uncertainty fixture. Preserve independent holdout identities and every existing negative policy/source/critic category.
- This changes the test policy, not the failed v1 result. Never relabel its ambiguous case, widen its ranges or reinterpret its observations as passing.

## Technical scope and frozen evidence

References describe `main` at `adf440e2901c5dcc9ec477afe543aa49d41bc25e`:

- `lib/contracts/grading.ts:14–46`: add the shared anchors and uncertainty instructions. `lib/contracts/study.ts:112–140`: retain the scored/uncertain output shapes; validate score/critical-flag coherence.
- `lib/content/qualification-contract.ts:103–186,227–294`: update fixture kinds, role instructions, bounds and critic semantics. Keep exact `includes()` grounding and independent privacy/originality gates.
- `lib/content/evaluation-contract.ts:70–130,321–356,441–456`: distinguish the five scored kinds from release-only `uncertain_context`; change expectation validation and coverage together.
- `lib/content/model-evaluation.ts:198–250` and private SQL `qualification_finish`, `evaluation_acceptance`, `evaluation_mismatches`: keep worker and DB acceptance rules consistent. Use a new migration; never rewrite deployed migrations.

Use new identities: `content-policy-v2`, `qualification-prompts-v2`, `qualification-schema-v2`, `machine-fixtures-v2`, `grader-v2`, `grade-prompt-v2` and `release-evaluation-v2`. Keep `grade-schema-v1` because its wire shape is unchanged. Keep the model snapshot unchanged for this comparison. Update strict configuration, receipt and dispatch consumers together; no mixed-version run or old approval reuse.

Before any future dispatch:

- Retain the original package, report, observations, ledger and hashes unchanged.
- Freeze a new dataset version and package identity, exact answers, contexts, evidence, bounds, pass expectations and rationales **before** observing revised model outputs. Privately record each change and its rule-based reason, including any corrected expectation. Do not tune expectations to observed scores.
- Bind both ordinary and repair requests, code/file hashes, model, protocol, prompts, validators, rubric versions, configuration and toolchain to the new plan. Changed candidate/rubric/evidence bytes require new immutable content versions.
- Keep v1 records readable, not reinterpreted or dispatched as v2. Stop unfinished incompatible work. Reusing labels or replaying input must not reset request allowances.
- Require fresh exact-version release evidence and separate provider/privacy/deployment/run records before live use, as specified in [T6](automated-content-feedback-spec.md#t6-runtime-gate-transition-only-after-approval-and-implementation) and the [evaluation guide](model-release-evaluation.md). Preserve existing shared spend caps, request limits and fail-closed gates.

## Decisions, assumptions and exclusions

- **Exact quotes over fuzzy matching:** fuzzy matching tolerates harmless edits but can hide unsupported evidence. Keep verbatim grounding; allow paraphrase only in explanatory fields.
- **Anchors over all-or-nothing grading:** anchors preserve partial reasoning. Numeric claims remain provisional, not externally calibrated human gold.
- **Separate uncertainty control over forced ambiguity:** one extra release control tests honest abstention without requiring an invalid question or evasive answer to produce uncertainty.
- **Assumptions proposed for approval:** equal atomic claim counting, revised-pilot threshold 4, the score-5 convention, and the v2 fixture amendment. The requester approved drafting, not these defaults.
- No new architecture, generation scaffolding, model comparison, human content pre-review, public answer keys, retroactive regrading or automatic release. Private pilot prompts, answers, rubrics, quotations and archive payloads stay outside this public repository.

## Validation criteria

These are **future implementation requirements**, not checks run by this spec. Use synthetic non-curriculum data and mocked transport.

1. Extend `tests/unit/content-qualification.test.ts` with `verbatim-grounding-only`, `support-not-substring-only`, `rights-and-privacy-independent`, `scored-bounds-complete-and-coherent` and `critic-judges-expectation`. Reject altered quotations, null/reversed/cross-threshold scored bounds and unjustified positive privacy/originality decisions.
2. Extend `tests/unit/grading.test.ts` with `anchors-0-through-5`, `required-claim-cap`, `concise-complete-not-penalized`, `vague-answer-scored` and `context-defect-uncertain`. Mocked output tests validate contracts, not model intelligence.
3. Extend `tests/unit/evaluation.test.ts`, `tests/integration/evaluation.test.ts` and `tests/integration/qualification.test.ts` with `v2-coverage`, `v1-history-unchanged`, `mixed-version-blocked`, `frozen-expectations-required` and `worker-db-parity`. Assert no receipt on mismatch and no dispatch without independent authorization.
4. Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` and the README's guarded isolated integration checks. Routine checks must not call a provider or hosted DB.

Use this invented card exercise for anchor acceptance, never actual pilot material: a fictional card prints “color: amber; shape: circle.” Its two required claims are the printed color and shape; its frozen score-5 criterion is explicitly identifying both as card labels rather than physical properties.

| Synthetic answer or context                                                                      | Frozen expectation                                                      |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| “Blue square” or “I will answer later”                                                           | 0, critical false, fail; not uncertain.                                 |
| “The color starts with a”                                                                        | 1 for a correct fragment; critical false, fail.                         |
| “Amber”; shape omitted                                                                           | 2, critical false, fail.                                                |
| “Amber circle, therefore every card has those labels”                                            | 3 for the unjustified generalization; critical true, fail.              |
| “Amber circle”                                                                                   | 4, critical true, pass; no verbosity penalty.                           |
| “Its printed labels are amber and circle; these do not assert physical properties”               | 5, critical true, pass.                                                 |
| Separate control asks for color but supplies conflicting authoritative labels with no precedence | Uncertain, specific context-conflict reason; null expected bounds/pass. |

Also use an invented snapshot “The marker is amber.” Accept that exact quote with a supported explanation. Reject quote “The marker appears amber.” A critic must support a deliberately false “marker is blue” fixture when its expected score is 0, and reject that same fixture when its expected score is 5.

For this docs-only PR, run pinned Prettier, `git diff --check` and relative-link/reference checks. Do not claim application tests, live quality or UI proof. Request approval of the committed rules without answer-key inspection; approval grants no additional execution authority.
