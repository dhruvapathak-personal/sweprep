# SWE Trainer

MVP 1 is a text-answer study loop: email-link sign-in, five candidate questions, cloud and local drafts, explicit conflict resolution, acknowledged timing, immutable submissions, durable grading recovery and history.

**This is a local demonstration, not a validated interview assessment.** All five questions and 25 example assessments await human review. No live model evaluation or paid provider call has been performed. Voice, vocabulary practice, adaptive sessions, charts, offline question loading and PWA installation are not implemented.

## Local setup

Use Node **24.0.0**, npm **11.3.0**, and a working Docker daemon. Dependencies and Supabase CLI **2.122.0** are pinned in `package-lock.json`. Routine tests make no paid API calls.

```bash
npm ci
npm run db:start
npm run db:reset
npm run setup:local
npm run dev
```

Open http://localhost:3000. Request a sign-in link using a test email address, then open the latest message in Mailpit at http://localhost:54324. Open the link in the same browser that requested it; the callback uses PKCE. Local email is not delivered externally.

In a second terminal, run `npm run worker`. This independent runner invokes the authenticated recovery endpoint every ten seconds. Closing the study tab does not stop it. Without the runner, submitted answers remain safely pending. `npm run worker -- --once` processes at most one due job.

`setup:local` writes `.env.local` with owner-only permissions and refuses to overwrite it. Never commit or share that file. It enables only loopback simulation with zero provider budgets; it needs no OpenAI key. Do not run local resets against a hosted database: reset deletes local study data.

## Demonstration flow and durability

- Choose a question, write an answer, select confidence and record any assistance. Use **Resume timer** to start acknowledged timing; **Pause** stops it.
- Edits save to IndexedDB, then to the cloud after two idle seconds or a ten-second checkpoint. The UI distinguishes cloud acknowledgment from a device-only snapshot. **Save to cloud** retries explicitly.
- For another device or isolated browser context, request another email link for the same account. Only the latest acknowledged revision transfers. A stale write shows both copies, confidence and assistance; selecting a copy never silently merges text.
- Disconnect an already loaded tab to edit locally. Reconnect before submitting. Offline time does not enter totals. A full offline page load is not supported.
- The timer has one server-held owner with a thirty-second lease. Explicit takeover discards the old owner's unacknowledged tail. Browser closure, connection loss and lease expiry can conservatively undercount time.
- Submit confirms an immutable answer. A lost acknowledgment retries the exact payload and idempotency key. A failed or uncertain grade is not a wrong answer. Regrading appends revisions and retains an earlier valid score until a valid correction or explicit invalidation.
- Prefix a simulated answer with `[simulate-failure]` to persist a first-generation failure, then retry. Prefix it with `[simulate-uncertain]` for an unscored result. Every simulated grade is labeled and excluded from learning evidence.
- Save and pause before viewing history or signing out. Explicit logout clears local snapshots. Local storage failures are visible; cloud saves remain available. History displays the latest 100 attempts, not a complete export.

## Checks and CI

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:integration
npm run db:types
```

Integration tests require Docker, the running local Supabase stack and a successful production build. They reset the local database, start a temporary compiled app on port 3001, then test real Auth, Postgres/RLS, concurrent submission, timer ownership, revision replay, request limits, budget reservations and authenticated HTTP recovery. They do not silently skip missing services. Stop any development recovery runner before testing so it cannot claim fixture jobs. CI runs these same checks and verifies generated database types.

The unit suite covers review graduation at both 30 elapsed UTC days **and** ten consecutive unassisted successes, relapse, neutral unscored outcomes, separate evidence tracks, local-day/DST timing, IndexedDB conflicts and the real SDK using mocked provider transport. Those mocks are not model-quality evidence.

## Deployment and live-grading gates

Ordinary API requests use a verified Supabase user and RLS, never the service-role key. Rubrics stay in a private schema. Only authenticated worker functions can reserve provider cost and append grades. Treat the service-role and recovery credentials as secrets.

Live grading stays disabled until a human completes all of these gates:

1. Review the five candidate question versions, rubrics, prerequisites, neutral vocabulary and all 25 expected assessments. Record reviewer and approval. Reviewed content must use new immutable question/rubric versions; do not edit an exposed version.
2. Run an explicitly approved, budgeted model evaluation. Require no pass/fail reversals, all ambiguous examples unscored and all scores within reviewed ranges. No paid evaluation command is shipped or run in this slice.
3. Approve provider retention/data policy. Do not submit confidential employer content or credentials. The adapter requests `store: false`; this does not establish the provider's complete retention policy.
4. Select and verify a hosted scheduler invoking `POST /api/internal/recover` at least once per minute with `Authorization: Bearer <RECOVERY_SECRET>`. Each invocation processes one job. Verify capacity and request duration for two possible 30-second calls plus finalization within a 90-second lease. A browser poll is not a worker. No hosted scheduler is configured or verified here.
5. Supply server-side credentials, the exact evaluated model snapshot and each approval flag listed in `.env.example`. Set `GRADING_MODE=live`, positive budgets no higher than **100 cents/day** and **2000 cents/month**, and the appropriate Supabase auth redirect/SMTP settings.

The implemented model adapter is pinned to `gpt-5.4-mini-2026-03-17`; compatibility and quality remain unverified against the live provider. Cost uses the documented $0.75/$4.50 per million input/output tokens and reserves ten cents before each dispatch. Unknown usage retains that reservation. Each generation allows at most three outbound requests, including one repair, with SDK retries disabled. Retry delays are 30 seconds then 120 seconds, or longer provider advice. New generations share global cost caps and a per-user limit of 30 grading requests/hour; an attempt has at most ten generations. A timeout may still incur a provider charge.

Simulation requires an explicit flag and loopback application/database URLs. It rejects hosted-production environments. Never describe simulated scores as assessed mastery or readiness.

## Devcontainer support

The optional `.devcontainer` uses pinned Node 24.0.0 without GPU, TUN, personal directories, SSH mounts or a privileged Docker socket. It supports application editing/building. Run Supabase on the host, not inside this image.

The default container's loopback is not the host's loopback. For Docker, configure a local override mapping `host.docker.internal` to `host-gateway`, then set the container's server-side Supabase URL to `http://host.docker.internal:54321`; keep grading disabled in that topology because simulation permits loopback only. The browser talks to the Next API, not directly to Supabase. The local auth callback still targets the forwarded app port. Full loopback simulation and Docker-backed integration tests use the native host commands above. Docker image construction and host-service reachability are tested separately; Podman, WSL, and native phone execution are not verified.

## Design sources

The original [implementation specification](docs/swe-trainer-implementation-specification.pdf) and the approved [architecture amendments](docs/architecture-proposal.md) define the product direction. The documents in `docs/` preserve their original documentation-stage wording. This README describes what this implementation actually runs.

The [Factory and Copilot agent guide](docs/factory-definition.md) explains the five translated Copilot agents and the preserved Factory source baseline. It does not deploy a live Factory.
