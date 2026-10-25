# Stack and coding standards

**Draft defaults for approval; no packages are installed.** [Reading guide and decisions](README.md) · [Architecture and recovery design](architecture-proposal.md)

## Gap 6: Package choices and coding standards

**Current evidence:** [PDF](swe-trainer-implementation-specification.pdf) pp. 7–8 name the framework/providers and “Zod or equivalent.” Pages 12–14 require tests and npm commands. The inspected repository has no `package.json`, lockfile, application code, or lint/test configuration.

**Missing behavior:** exact library roles, import boundaries, test layers, formatting rules, and automated merge gates are not yet selected.

**Practical consequence:** different contributors can add overlapping tools or incompatible versions, test only mocked security, or assume a package does more than it actually does.

**Proposed fix:** approve the small stack and standards below as the default. Add a package only when its phase needs it. Pin compatible versions and create scripts only in a separately authorized implementation change.

**Trade-off:** a consistent stack makes changes easier to review and reproduce, but requires occasional coordinated upgrades. Avoid installing every package from a future phase on day one.

**Acceptance evidence:** a future tool-setup PR must demonstrate the listed scripts, one deterministic domain test, one authenticated Postgres/RLS integration test, and a production build. Later UI and browser tools enter when those workflows are implemented.

**Approval question:** approve npm, the official SDKs, Zod, Vitest, layered tests, and the standards as the baseline; exact compatible versions remain a setup decision.

## 1. Packages in learning order

### Existing framework direction

Keep the PDF choices:

- [`next`](https://nextjs.org/docs/app/getting-started/installation), maintained by the Next.js project/Vercel: routing, server rendering, route handlers, and production build.
- [`react` and `react-dom`](https://react.dev/learn), maintained by the React project: components and their browser rendering. Use the pair supported by the pinned Next.js release.
- [`typescript`](https://www.typescriptlang.org/docs/), maintained by Microsoft and the TypeScript project: compile-time checks for developer-written code. Types are erased when JavaScript runs; they do not inspect an incoming request.
- [`tailwindcss`](https://tailwindcss.com/docs/installation/framework-guides/nextjs), maintained by Tailwind Labs: reusable styling utilities. For its current documented Next.js setup, build dependencies include `@tailwindcss/postcss` and `postcss`. Follow the chosen major version's setup rather than copying a different major's configuration.
- `@types/node`, `@types/react`, and `@types/react-dom`, maintained through [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped): development-time type declarations matched to the chosen runtime/framework.

### Official production SDKs

SDK means **software development kit**. Here it is a provider-maintained library that wraps requests to a service already in the architecture. These three packages do not mean three additional servers.

1. **[`@supabase/supabase-js`](https://github.com/supabase/supabase-js), maintained by Supabase.**
   - Calls Supabase Auth and its data/storage APIs.
   - Used by the database/auth adapter. The browser may use a public publishable key for sign-in; that key is not permission to access every row.
   - For ordinary server data requests, keep the authenticated user's identity so RLS applies.
   - Privileged/legacy service-role keys stay server-only and are restricted to narrowly authorized maintenance or recovery paths. They can bypass RLS.
2. **[`@supabase/ssr`](https://supabase.com/docs/guides/auth/server-side/creating-a-client), maintained by Supabase.**
   - SSR means **server-side rendering**. This helper connects Supabase sessions to cookies so a Next.js server can recognize the signed-in user.
   - It complements `supabase-js`; it does not replace the database or add another authentication provider.
   - Create separate browser and request-specific server clients. Follow the official refresh/verified-identity flow for the pinned Next.js major; file naming for that flow is version-sensitive.
   - Do not share one user's server client/cookies across requests or cache auth responses across users.
3. **[`openai`](https://github.com/openai/openai-node), maintained by OpenAI.**
   - The official JavaScript/TypeScript SDK for grading, later generation, and transcription.
   - Import it only inside the server AI adapter. Never enable browser execution with a secret API key.
   - Prefer the provider's current Responses API for new structured grading, with a pinned task/model configuration validated against fixtures. Select the model separately from the SDK version.
   - Its networking/retry conveniences do not provide durable application execution, guarantee factual truth, or make database writes idempotent.

Use the Next.js [`server-only` import guard](https://nextjs.org/docs/app/getting-started/server-and-client-components#preventing-environment-poisoning) for secret-bearing modules. It helps catch accidental client imports; it does not replace authorization or key management.

### Zod: checks for actual incoming data

Recommend the exact package [`zod`](https://zod.dev/), maintained by the Zod project.

TypeScript helps a developer avoid passing a string where a number is expected. But the network can still send `"five"` as a score, or an AI can return a score of 12. TypeScript annotations alone cannot stop that.

Zod describes the allowed shape and checks the actual data at runtime. For a grade it can require:

- An integer score from 0 to 5 when the outcome is scored.
- A known outcome such as scored or uncertain.
- Bounded arrays of explanatory claims and known enum values.
- Required version identifiers and bounded text sizes.

Use it at API requests, provider responses, environment settings, and stored JSON boundaries. Infer TypeScript types from the same schemas where practical to reduce duplicate definitions.

Zod cannot tell whether a C++ explanation is true. A score of 4 can satisfy the schema and still be wrong. Human-reviewed rubrics, evaluation examples, and trusted pass-rule checks address that separate problem. Do not send private grading schemas/rubrics into the browser merely because some public contracts are shared.

**Alternative:** hand-written validators reduce dependencies, but increase repetitive error handling and the risk that types and checks disagree. Zod is already named by PDF p. 8 and provides a small, consistent boundary vocabulary.

### Vitest: fast tests for learning rules

Recommend [`vitest`](https://vitest.dev/guide/), maintained by the Vitest project.

A test runner executes example inputs, compares actual results with expected results, and reports failures. Vitest runs TypeScript unit tests such as “ten correct answers on day 29 must not graduate a question.”

- Use it first for pure scheduling, timer, analytics, and contract tests.
- Inject a clock and random-number source into domain functions. A test can then advance thirty days instantly and produce repeatable scheduling jitter.
- Mock OpenAI for routine tests. A mock is a controlled substitute; it proves failure handling, not the real model's grading quality.
- Vitest uses Vite tooling internally. This does not replace Next.js's application build system. Resolve the chosen Vitest/Vite/Node requirements together.
- Do not rely on unit rendering of asynchronous Next.js server components as a substitute for real integration/browser tests.

**Alternative:** one browser tool for every test avoids two runners, but makes simple thirty-day rule tests slower and harder to diagnose. Keep fast rule tests separate from full workflows.

### UI behavior tests when components arrive

Recommend these development-only tools when there is meaningful component behavior:

- [`@testing-library/react`](https://testing-library.com/docs/react-testing-library/intro/), maintained by Testing Library: renders components and checks them through user-facing labels, roles, and actions. Include its required peer package `@testing-library/dom`, the shared document-querying layer.
- [`@testing-library/jest-dom`](https://github.com/testing-library/jest-dom), maintained by Testing Library: readable assertions such as “this control is disabled.” Despite the name, it can be configured with Vitest; installing Jest is not required.
- [`jsdom`](https://github.com/jsdom/jsdom), maintained by the jsdom project: a simulated browser document for fast component tests. It is not a real browser and cannot prove installation, audio permission behavior, or actual layout.

UI means **user interface**. Test behavior rather than private component variables. For example, check that an uncertain grade displays “unscored,” not whether a hook has a particular internal value.

### End-to-end browser tests and database integration

- [`@playwright/test`](https://playwright.dev/docs/intro), maintained by Microsoft/the Playwright project: automated browser workflows, such as sign-in → answer → submit → reload. E2E means **end-to-end**, crossing the browser/server boundary.
- [`supabase`](https://supabase.com/docs/guides/local-development), Supabase's command-line tool, as a pinned development dependency: local services, database migrations, resets, and generated database types.
- Use a real local Supabase/Postgres database for transaction, uniqueness, permissions, and RLS integration tests. Use the authenticated `supabase-js` clients and the same SQL migrations as hosted deployment. SQLite cannot prove Postgres RLS behavior.
- Automated browser assertions do not replace visual verification. Future interactive UI changes require computer-use video after a successful build, plus desktop/mobile and keyboard checks. Static-only rendering can use screenshots.

### Lint and format tools

- [`eslint`](https://eslint.org/docs/latest/use/), plus [`eslint-config-next`](https://nextjs.org/docs/app/api-reference/config/eslint): report suspicious code, framework misuse, and agreed import rules.
- [`prettier`](https://prettier.io/docs/), plus [`eslint-config-prettier`](https://github.com/prettier/eslint-config-prettier): format files consistently and disable conflicting formatting rules in ESLint.
- Use TypeScript-aware lint support compatible with the pinned Next.js configuration; add [`typescript-eslint`](https://typescript-eslint.io/getting-started/) explicitly only if the selected configuration needs it.

A linter finds patterns; a formatter chooses spacing and layout. Neither proves the learning algorithm is correct. Recommend two-space indentation, single quotes in TypeScript, semicolons, and formatter-managed trailing commas/line wrapping. SQL migrations use lowercase `snake_case` names and consistent two-space indentation.

## 2. Dependency and version policy

- Use **npm**, Node's package manager, matching PDF p. 13. Do not add pnpm/Yarn/Bun or use Pixi to manage application JavaScript packages.
- Before app setup, select one supported Node **LTS** release and compatible npm. LTS means a release line receiving long-term maintenance.
- Check compatibility across all selected tools, not just Next.js's minimum Node version. The official Vitest guide checked for this draft requires Node 22.12+ and Vite 6.4+; Zod's current guide tests TypeScript 5.5+. Those are compatibility evidence, not pinned project versions.
- Record exact chosen versions in the future setup change. Pin direct package versions and commit `package-lock.json`, which records the resolved dependency tree. Use `npm ci` in clean development/CI installs.
- Review security updates and run the full gates on upgrades. Do not deploy unreviewed `latest` changes.
- Start without an ORM, an **object-relational mapper** that maps application objects to database tables. Supabase's typed queries and SQL migrations already cover the first slice. An ORM adds another schema/tool layer without removing the need for SQL, RLS, or atomic database functions.
- This is a starting trade-off, not a permanent ORM ban. Reconsider if query complexity demonstrates a concrete benefit.
- Defer chart, diagram/math-rendering, audio helpers, IndexedDB wrapper, and PWA/service-worker helper packages until the relevant feature needs them. IndexedDB and browser audio APIs already exist in the platform; a wrapper is convenience, not a second storage authority.
- Do not add an AI orchestration framework for a single provider/graded-call workflow without a demonstrated need. Keep provider logic behind the adapter so it can be replaced later.

Official guides were checked during this documentation review. Their moving pages are not a substitute for a later version compatibility/pin step. No model identifier or package version is invented here.

## 3. Concrete coding standards and why they matter

### Types, boundaries, and errors

- Enable strict TypeScript. Treat unknown external data as `unknown` until validated; do not silence errors with unexplained `any`, non-null assertions, or unsafe casts.
- Validate requests, environment variables, AI responses, and stored JSON with Zod at the boundary. Check business rules after parsing: an in-range score can still violate the rubric's pass rule.
- Use explicit result states, not a pile of booleans. For example, scored has a score; uncertain has a reason and no invented zero score.
- Define typed, stable errors such as `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `SYNC_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `GRADING_PENDING`, `GRADING_FAILED`, and `BUDGET_EXCEEDED`.
- Separate user-fixable errors, retryable provider failures, and terminal failures. Show the next valid action; do not leave the interface on an endless spinner.
- Route handlers map errors to HTTP status and safe messages. They must not return stack traces or provider credentials.

### Naming, module ownership, and dependency direction

- Use `PascalCase` for React components and types, `camelCase` for functions/variables, and `snake_case` for SQL columns/tables.
- Keep Next.js-required filenames (`page.tsx`, `layout.tsx`, `route.ts`); otherwise prefer descriptive kebab-case file names and `*.test.ts`/`*.test.tsx` test names.
- Name units explicitly: `activeMs`, `timeoutSeconds`, `submittedAt`. Do not mix seconds and milliseconds in an unqualified `duration`.
- Keep learning rules in `lib/domain/`, workflows in server services, provider code in adapters, and safe shared schemas in contracts, as defined in the architecture document.
- Enforce imports toward those boundaries: browser → safe contracts/components; server service → domain/adapters; domain → no Next.js, SDK, database, or browser dependencies.
- Avoid a generic `utils` dumping ground and circular imports. Add an abstraction when it has an actual second use or isolates a real boundary, not to prepare for hypothetical microservices.

### Secrets, content rendering, and AI boundaries

- Mark secret-bearing modules server-only. Validate environment configuration once on the server and fail with a safe setup error when required values are missing.
- Never prefix OpenAI or privileged Supabase secrets with `NEXT_PUBLIC_`; that prefix exposes values to client bundles. Public Supabase publishable settings still require RLS.
- Keep rubric/reference answers private until the release conditions in the architecture contract are satisfied.
- Render allowlisted text/code/table/math/diagram blocks, as PDF p. 4 requires. Do not insert raw model HTML or execute generated code. Apply safe Markdown/link/diagram handling, resource limits, and text alternatives when richer rendering is introduced.
- Treat learner answers and generated content as data, not instructions to server tools. The grader must not gain database-write or arbitrary-tool privileges from prompt text.
- Version prompts, rubrics, model/task configuration, schemas, and evaluation fixtures together. Never change the question being answered through silent regeneration.

### SQL, history, and migration discipline

- A migration is an ordered, versioned SQL change checked into the repository. New deployments and local tests must rebuild the same schema from these files.
- Add constraints for identity, ownership relationships, state values, score range, user-scoped idempotency keys, session sequence, and permitted initial submission count.
- Use database transactions/functions for atomic finalization. Several successful HTTP calls to the database are not one atomic transaction.
- Enforce RLS and table/function privileges in migrations, not only application filters. Test both direct database API access and application routes.
- Restrict privileged SQL functions by caller/owner and fixed execution context. Never expose a general “grade any attempt” function to learners.
- Do not edit submitted attempt history or overwrite grading revisions. Store explicit corrected-grade selections and deterministic projections.
- Add a new migration to change a deployed schema; do not rewrite an already-applied migration. Explain data preservation and recovery for destructive changes before approval.
- Generate TypeScript database types from the migration-backed schema; do not maintain a second handwritten schema by guesswork.

### Time and learning evidence

- Store timezone-aware timestamps using UTC, **Coordinated Universal Time**. Render using the user's profile timezone, initially detected from the browser as the PDF specifies.
- Define daily totals by the selected profile timezone, not the server machine's timezone. Split active segments at local midnight, including daylight-saving transitions.
- Proposed default: changing profile timezone recomputes displayed historical local-day totals using the new selected zone; immutable UTC events do not change. Label that behavior rather than silently mixing zones.
- Derive active time from acknowledged timestamp segments minus pauses. Browser intervals only refresh the display; do not increment authoritative time once per tick.
- Preserve first-attempt, assisted, review, concept, and vocabulary distinctions. An uncertain result is not wrong; repeated reviews are not new first attempts.
- Inject clock/random sources in tests. Persist actual scheduled due times and the inputs needed for reproducible correction.

### Accessibility and privacy-safe observability

- Provide labels, keyboard operation, visible focus, sensible tab order, sufficient contrast, touch-friendly targets, and text alternatives for diagrams.
- Announce pause/resume and grading changes to assistive technology, not every timer tick. Do not require microphone access or force automatic submission.
- Show meaningful empty, loading, offline, local-only-save, conflict, pending, failed, and uncertain states.
- Log request correlation IDs, safe error codes, state changes, model/prompt versions, latency, and usage/cost. A correlation ID connects events without copying the answer into logs.
- Do not log full answers, audio, authentication cookies/tokens, secrets, or provider request bodies. Use anonymized/synthetic fixtures for debugging.
- When audio arrives, delete stored audio after transcription by default and document exceptional retention explicitly.

## 4. Proposed validation gates

**These commands are not implemented in this repository.** They describe the future package-script contract, not instructions to run now.

- `npm ci`: install the committed dependency tree without rewriting the lockfile.
- `npm run lint`: run ESLint directly, including framework and import-boundary rules. Do not assume `next lint` exists or `next build` runs lint.
- `npm run format:check`: run Prettier in check-only mode.
- `npm run typecheck`: run the chosen Next.js-compatible type generation/type-check sequence with no emitted application output.
- `npm test -- --run`: run Vitest once, not in interactive watch mode.
- `npm run test:integration`: apply/reset migrations in an isolated local Supabase database and exercise RLS, concurrent submissions, atomic finalization, and replay.
- `npm run test:e2e`: run Playwright against a test deployment with isolated accounts and stubbed AI; never paid AI by default.
- `npm run build`: compile a production application; no swallowed type/build failures.
- `npm run eval:grading`: explicit, separately budget-approved live golden evaluation; not part of default CI.

CI means **continuous integration**: automated checks on proposed changes. Run install, lint, format, type checks, unit tests, real-database tests, relevant browser tests, and build before claiming an application change is ready. Use isolated synthetic test data and never production credentials.

Test the behaviors named in each architecture gap. Also require:

- `analytics.first-attempt-excludes-assisted-and-repeats`.
- `analytics.vocabulary-separate-from-concept`.
- `time.pause-excluded`, `time.local-midnight-split`, `time.daylight-saving`, and `time.timezone-change-rebucket`.
- `auth.cross-user-read-denied`, `auth.cross-user-write-denied`, `auth.cannot-forge-grade`, and `content.private-rubric-denied`.
- `ui.keyboard-answer-submit-resume` and real-device/browser checks when audio/PWA phases arrive.

Do not set an arbitrary code-coverage percentage as a substitute for those behaviors. A large percentage can miss a single critical authorization or mastery rule. Assert outcomes, boundary cases, concurrent effects, and recovery after failure.

For future UI changes, require successful build plus computer-use visual evidence. Use video for answering, save states, recovery, and cross-device-width flows; use screenshots for a truly static render. A responsive-width test is not proof that every phone browser's microphone/PWA behavior works.

## 5. Documentation-only acceptance for this PR

- Changed repository files are Markdown documentation only. The original PDF and both devcontainer files are byte-for-byte unchanged.
- The reading entrypoint links all focused documents; relative links and heading anchors resolve.
- PDF page citations and container line ranges match the inspected sources.
- Every gap identifies evidence, missing behavior, consequence, proposed fix, trade-offs, acceptance evidence, and an approval question.
- Recommendations are distinguishable from existing requirements. No installation, migration, application build, feature test, or visual UI test is claimed.
- Remaining product/hosting/privacy/version decisions are visible for approval. No credentials are requested or included.
