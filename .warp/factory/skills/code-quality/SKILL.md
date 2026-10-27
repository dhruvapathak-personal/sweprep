---
name: code-quality
description: "The standard a code change is held to: correctness, standards, complexity, naming, comments, tests, and security. Use when writing a code change and when judging one, so the author and the reviewer work from one definition."
---

# code-quality

The standard a change is held to. The author writes to it; the reviewer judges against it.

The repository's own agent-facing guidance outranks this file: a root `AGENTS.md`, `WARP.md`, or `CLAUDE.md`, and any directory-scoped equivalent nearer the files. Find it first. Where it is specific and this is general, it wins.

## Dimensions

- Correctness: does what it intends, edge cases and error handling included.
- Standards: the repository's and the language's conventions, idioms, lint and format rules, over personal preference.
- Complexity: no needless complexity, dead code, over-long functions, or meaningful performance problems; prefer the simpler equivalent. Setup that only exists to exercise the change by hand does not belong in the diff.
- Naming: clear, accurate, consistent.
- Comments: a comment must be intelligible without looking anything up — this PR, the review, a ticket, or an earlier revision — and it must tell the reader something the code doesn't already say; either failure means delete it. The reader is a senior engineer: a comment that says again what the names already say, or narrates the syntax line by line ("initialize the array", "loop over the users"), is redundant. Keep a local view: not a caller, not another unit's internals. Past behavior belongs only when it prevents a likely regression, and then only as what breaks. Stale, misleading, and redundant comments are defects. The doc comment on a container (struct, class, enum, trait, interface) describes the item as a whole, not its members; each member's own doc comment explains that member without restating the container's. An existing comment is deleted or rewritten only when the logic it describes changed.
- Tests: a bug fix carries a regression test that fails before and passes after; a feature covers its behavior and edge cases. Exempt: config-only, dependency or version bumps, constant or flag defaults, pure data or copy. A test that only varies already-covered inputs adds nothing. Production code never grows a seam to make a test possible — a swappable package-level variable, an exported internal, a tunable interval — and finding the same seam elsewhere in the repository argues that it spread, not that it is right.
- Security: injection, authentication and authorization, secret handling, unsafe input.

## sweprep product context

Baseline observed on 2026-10-25 in `dhruvapathak-personal/sweprep`. Reinspect the checkout before work; later repository guidance and implemented scripts can supersede this baseline.

### Existing repository

- `README.md` contains only the project name. The tracked tree contains `.devcontainer/` and `docs/swe-trainer-implementation-specification.pdf`, but no application, package manifest, lockfile, tests, CI workflows, agent guidance, PR template, or CODEOWNERS.
- `.devcontainer/Dockerfile` and `.devcontainer/devcontainer.json` describe an interactive Ubuntu/Python/Pixi environment. They are not evidence that the product uses Python or that the cloud runner has the same tools, host mounts, or devices.
- The PDF, version 1.0 dated October 20, 2026, is the product build reference. Its architecture, repository skeleton, and developer commands are plans, not existing code or runnable checks.

### Planned contracts

- Architecture (PDF sections 10–11): Next.js App Router, React, TypeScript, Tailwind, Supabase Postgres/Auth, and server-side OpenAI calls. Keep privileged keys server-only and enforce per-user RLS even for the initial single-user-friendly release.
- Initial implementation scope (sections 16, 19): build Phase 1 first unless the request specifies another scope. Prove sign-in, a seeded question, timing, text submission, grading, immutable history, and reload/resume before claiming adaptive learning, voice, or charts are complete.
- Learning invariants (sections 5, 7–8, 14): missed-question graduation requires both 30 days since the first miss and 10 consecutive unassisted correct responses. Wrong answers reset the streak; assisted correct responses do not increase it. Keep vocabulary, conceptual mastery, first attempts, and review metrics distinct. The approximate 20% predicted correctness target applies only to new challenge questions.
- Persistence and timing (sections 6, 9, 11): the cloud database is authoritative. Preserve immutable attempts and exact question/rubric/grader versions, append regrades, and make submissions idempotent. Compute active time from timestamps and pause intervals, store UTC, and aggregate daily totals in the user's timezone.
- AI safety (sections 4, 13, 15): validate structured outputs and safe content blocks; do not render model-generated raw HTML. Treat answers as untrusted input, keep rubrics hidden until grading completes, and delete stored audio after transcription by default.

### Verification

- PDF section 16 calls for unit coverage of graduation boundaries, assisted/wrong answers, separate metrics, and pause/local-day timing; integration coverage of submission retries and cross-user isolation; and end-to-end coverage of study flow and cross-device resume. Apply these checks when implementing the relevant feature.
- Section 18 recommends `npm run dev`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run test:e2e`. None is available in the observed checkout because no package manifest exists. Discover actual scripts and tool versions before running them; report missing checks rather than claiming a pass. Do not add product scaffolding just to validate a factory-context edit.
