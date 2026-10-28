# SWE Trainer: design proposal

**Status: documentation-only draft for human approval. No application implementation is approved by this proposal.**

**Current-state note:** this page records the original architecture proposal. MVP 1 now exists; use the [root README](../README.md) for current setup and active runtime gates. The human [approved A1–A6 in PR #2](https://github.com/dhruvapathak-personal/sweprep/pull/2#pullrequestreview-5645597629). The [automated-content and post-grade learning specification](automated-content-feedback-spec.md) proposes a focused amendment to A4, not a claim that its replacement is implemented or approved.

## Start here

The [original 14-page specification](swe-trainer-implementation-specification.pdf) is a strong starting point for architecture design. It explains the learning goals, principal screens, data model, and important rules. It is not yet a complete implementation contract: some recovery behavior conflicts, and the development tools and coding standards are not selected.

This draft explains those gaps before suggesting changes. It preserves the PDF and existing development container. It does not install packages, scaffold the application, change configuration, or claim working features.
The PDF calls its staged first release the **MVP**, or minimum viable product: the smallest useful version, not every planned feature. Its **PWA**, or Progressive Web App, is a website with browser-supported installation and selected offline behavior.

Read in this order:

1. This page: the recommendation and decisions to approve.
2. [Architecture and gaps](architecture-proposal.md): how the pieces fit together, why each gap matters, and how to prove a future fix.
3. [Stack and coding standards](stack-and-standards.md): what each proposed package does, when it is needed, and concrete engineering rules.

You do not need to approve every future package now. First agree on the architecture and behavior. Choose exact compatible versions when application setup is separately authorized.

## How to read the status labels

- **Existing requirement:** already stated in the PDF. A citation such as “PDF p. 7” refers to its printed page number, which matches the PDF page number.
- **Proposed default:** a recommendation in this draft. It is not an approved change to the PDF.
- **Decision before affected implementation:** a choice that must be resolved before building that area, not a blocker to reviewing these documents.
- **Deferred:** intentionally outside the first slice, not removed from the longer-term product.

If a proposed default conflicts with the PDF, the PDF remains authoritative until the human explicitly approves the change. Review of this draft does not authorize implementation.

## Recommendation in plain language

Keep the technology direction already chosen on PDF pp. 2 and 7:

- **Next.js App Router** organizes pages and server endpoints in one application. An **API**, or application programming interface, is how the browser asks the server to perform work.
- **React** builds the user interface from reusable components.
- **TypeScript** checks developer-written types before the application runs.
- **Tailwind CSS**, or Cascading Style Sheets utilities, styles the interface.
- **Supabase Postgres** stores the shared learning history. Postgres is a relational database: it stores related records and enforces rules between them.
- **Supabase Auth** signs users in. Database **row-level security (RLS)** controls which records each user can access.
- **OpenAI** provides the artificial intelligence (**AI**) for grading and, later, content generation and transcription. Only the server calls it.

Recommend a **modular monolith**: one deployed application with clear internal responsibilities. “Monolith” means one application, not one enormous file. “Modular” means that display code, learning rules, database access, and AI access remain separate. This avoids the deployment and networking work of multiple independent services while keeping the rules easy to test.

The first demonstration follows the PDF p. 14 slice: sign in, load a qualified question, type an answer, submit, grade, save, and reload the same result. It also demonstrates honest save status and recoverable grading. Voice, charts, and full adaptive selection need not arrive first. The original human-reviewed qualification policy remains active in code until the proposed A4 replacement is approved and implemented.

## Approval decisions and proposed defaults

These were the original approval questions, not a request to provide credentials. A1–A6 were subsequently approved in PR #2. A4 below now identifies the proposed policy amendment from issue #9; unrelated decisions retain their existing approval status.

### A1. Draft and offline guarantees

**Proposed default:** save active text drafts to the server in the first slice, plus local recovery snapshots on that device. Show “Saved to cloud,” “Saved on this device only,” and conflict states. Cross-device resume includes only acknowledged cloud saves. Cache the non-private application shell when PWA work arrives in MVP 3.

**Approve before draft/resume implementation:** Is that phase split acceptable, including conservative acknowledged-online timing? Unsynced edits cannot reach an offline second device. Offline editing does not imply offline grading, durable offline submission, or accurate merged cross-device timer totals. Proposed daily totals follow the profile timezone; changing it re-groups historical totals without changing stored events. See [gap 1](architecture-proposal.md#gap-1-drafts-offline-scope-and-timer-ownership).

### A2. Grading recovery and hosting

**Proposed default:** persist the answer before contacting OpenAI. Use recoverable grading states and bounded retries. A host-managed scheduled invocation recovers abandoned work even when the browser closes; polling only displays progress.

**Decide before grading deployment:** approve a host and plan that support the required invocation frequency and execution limit, or select a provider-managed durable execution facility. Do not build custom queue infrastructure. See [gap 2](architecture-proposal.md#gap-2-recoverable-grading-and-transaction-boundaries).

### A3. Corrected grades and a new failure after graduation

**Proposed default:** append grade revisions, select one effective revision with an audit trail, and recalculate affected mastery and analytics. Pending, failed, and uncertain grades count as neither correct nor incorrect.

**Product choices to approve:** after graduation, a new scored failure starts a new 30-day review episode while keeping the previous episode. This is stricter than retaining the original `first_missed_at` forever. Measure the minimum as 30 elapsed 24-hour days, and treat a neutral pre-session primer differently from an in-question lookup. The rule remains **30 days AND 10 consecutive unassisted correct review answers**, not one condition or the other. See [gap 3](architecture-proposal.md#gap-3-grade-revisions-uncertainty-and-relapse).

### A4. Content, evaluation, spending, and privacy

**Proposed amendment, not yet implemented:** remove mandatory human pre-review of questions, rubrics, terms, and evaluation fixtures, including initial seeds. Use original source-backed authoring, deterministic checks where valid, a separate adversarial critic, machine-authored evaluation cases, and fail-closed quarantine/revise/discard. Model agreement does not establish truth. Existing five candidate seeds are not automatically qualified.

**Delivery targets:** first forty qualified questions and 60–80 terms across all eight PDF domains, released in batches of at most ten questions; later 120 questions and 150–200 terms. These are targets, not calibrated quantities. Content/catalog work can proceed alongside MVP 2 without waiting for full adaptive sessions. Fifteen is a session size, not the bank limit.

**Post-attempt learning:** add persistent clarification about specific grading feedback and the learner's submitted reasoning. Distinguish the evaluator's generated example answer from the canonical private reference. Accept optional correction proposals through a narrow automated publisher; preserve frozen versions and past grades. No human-content review fallback or silent chat regrading is introduced.

**Approve the amended design before implementation:** review [the complete contract and approval decisions](automated-content-feedback-spec.md#human-approval-requested), not answer keys. Spending ceilings remain US$1/day and US$20/month unless separately approved. Privacy/provider-data policy, release evaluation, deployment and engineering review remain independent gates. Current runtime flags stay unchanged until a tested replacement is implemented. See [gap 4](architecture-proposal.md#gap-4-trustworthy-content-and-a-small-grading-baseline).

### A5. Reproducible development and packages

**Proposed default:** use one supported Node.js Long-Term Support (LTS) release, npm, one committed lockfile, local Supabase/Postgres for database tests, and the official SDKs listed in the [stack proposal](stack-and-standards.md#official-production-sdks). Node runs JavaScript outside the browser; npm installs packages; a lockfile records the exact dependency tree. An SDK is a software development kit: here, a provider-maintained library for calling its existing service, not another service to deploy.

**Approve before environment/tooling implementation:** keep personal graphics processing unit (GPU) access, host mounts, and agent tooling optional. A host mount makes part of your computer's files available inside a container. Choose the exact compatible runtime/package versions and verify the Docker/Podman database workflow on the intended machine. Nothing in this PR changes the container. See [gap 5](architecture-proposal.md#gap-5-the-container-is-not-yet-an-app-development-contract) and [gap 6](stack-and-standards.md#gap-6-package-choices-and-coding-standards).

### A6. First sign-in method

**Proposed default:** Supabase passwordless email for the first slice; Google sign-in can follow. This minimizes initial provider setup but depends on reliable email delivery and verified redirect URLs.

**Approve before authentication implementation:** confirm email-first versus Google-first. This does not change the requirement to keep users isolated, even for one-person use (PDF pp. 2, 7, 11).

## Assumptions and deferred scope

- A1–A6 were approved in PR #2; the issue #9 amendment to A4 awaits separate approval. Do not infer approval of new content automation or clarification features from the earlier review.
- The original no-application baseline is historical. Current code and the root README supersede its setup/tooling observations.
- Preserve the current PDF and container during this review. Container portability findings are static observations, not results of a build.
- Retain all PDF curriculum domains. The five-question seed is a small historical test surface, not a replacement curriculum or an automatically qualified bank.
- Defer voice/edit, rich diagrams, competency charts, and PWA installability to their PDF p. 12 phases.
- Defer full offline sessions, offline submission queues, and full offline voice transcription.
- Defer large model-comparison studies and Principal-depth assessments. The proposed automated qualification/evaluation baseline must precede newly qualified learner-facing scores; it is not human gold or readiness calibration.
- Do not add microservices, Kubernetes, custom queue infrastructure, native mobile builds, or a new package manager.

## Compact glossary

- **API — application programming interface:** a defined way for one program to request work from another.
- **Authentication / authorization:** proving who you are / checking what you may access.
- **Boundary:** a place where data crosses between systems or responsibilities and needs checks.
- **Cache / authoritative storage:** a convenience copy / the source that decides the committed truth.
- **CI — continuous integration:** automated checks on a proposed code change.
- **Domain code / adapter:** learning rules / code that translates those rules into database or AI calls.
- **E2E — end-to-end:** a test of a complete user workflow across the browser and server.
- **Idempotency:** retrying the same operation does not apply its database effects twice.
- **IndexedDB:** browser-managed local storage. It does not automatically synchronize between devices.
- **Invariant:** a rule that must remain true, including after a crash or retry.
- **JSON — JavaScript Object Notation:** a common structured-data format.
- **Lease:** temporary permission to own work; it expires so a crashed owner does not block recovery.
- **Migration:** a versioned database change, stored in the repository and applied in order.
- **PWA — Progressive Web App:** a website that can offer installation and selected offline behavior where the browser supports it.
- **RLS — row-level security:** database rules that limit access to individual rows.
- **Rubric / evaluation fixture:** scoring rules / an example assessment used to check the grader. Machine-authored fixtures are not independent human-gold labels.
- **Runtime validation:** checking actual data while the program runs, not only checking source-code types.
- **SDK / SSR:** software development kit / server-side rendering, where the server prepares a page.
- **SQL — Structured Query Language:** the language used to define and query relational data.
- **State machine:** named states and allowed transitions, so “pending,” “failed,” and “finished” have precise meanings.
- **Transaction:** database changes that commit together or do not commit at all.
- **UTC — Coordinated Universal Time:** the common time reference used for stored timestamps.
- **Zod / Vitest:** the proposed runtime data validator / automated unit-test runner, explained in the stack document.

## What approval means

A1–A6's original approval is recorded above. Please approve or amend the focused [issue #9 contract](automated-content-feedback-spec.md#human-approval-requested) before affected implementation. Record the replacement of the PDF's mandatory human-gold policy explicitly. Reviewing this proposal does not authorize paid calls, content publication, hosted changes, deployment, or implementation.
