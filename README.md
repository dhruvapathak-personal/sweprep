# SWE Trainer

MVP 1 is a text-answer study loop: Google-only sign-in, five candidate questions, cloud and local drafts, explicit conflict resolution, acknowledged timing, immutable submissions, durable grading recovery and history.

**This is a development build, not a validated interview assessment.** All five questions and 25 example assessments await human review. No live model evaluation or paid provider call has been performed. Voice, vocabulary practice, adaptive sessions, charts, offline question loading and PWA installation are not implemented.

## Local setup

Normal development connects the app container to a **requester-owned, isolated hosted DEV Supabase project**. All project dependencies, app commands and optional personal tools run in containers. The WSL/Linux host needs only core services such as Podman, Git, SSH and the editor/Dev Containers client: no host Node, npm, Python or Supabase CLI installation. Neither developer target has an engine socket or lifecycle client.

Open this repository with your Dev Containers client using `.devcontainer/devcontainer.json` for Linux Docker or `.devcontainer/podman/devcontainer.json` for rootless Podman (set the client's host engine path to `podman`). The client needs to control the host engine; the resulting app container does not. `postCreateCommand` runs `npm ci`. After completing the hosted project/environment and Google setup below, run inside the app container:

```bash
npm ci
npm run dev
```

Node **24.22.1** and its bundled npm **11.19.1** match `.nvmrc`, CI and the lockfile. No global npm override is needed. Each profile uses bridge networking and publishes container port 3000 only at host `127.0.0.1:3000`; the app listens on `0.0.0.0` inside the container. Open http://localhost:3000. Ordinary outbound HTTPS/DNS reaches hosted Supabase and Google without host networking. Do not open two profiles on the same port.

### Hosted DEV project and environment

1. In your own Supabase account, create or select an isolated **DEV** project with no production data. Confirm its project reference before every dashboard operation. Never reuse production keys or reset a hosted project for tests. No hosted project or credential is provisioned automatically.
2. For a **new, empty DEV project**, use its [Dashboard SQL Editor](https://supabase.com/docs/guides/database/overview) to review and apply `supabase/migrations/202610250001_core.sql`, `202610250002_grading.sql`, then `202610250003_state.sql`, in that order. Apply `supabase/seed.sql` once afterward for the five candidate questions. Record the commit and successfully applied filenames with the DEV project. These are not replay-safe setup scripts; stop on errors, never rerun them blindly, and do not apply this initial setup to an existing populated project. Keep the private schema out of exposed API schemas; retain all RLS policies and function grants. Dashboard application does not create a CLI migration ledger; reconcile that history explicitly before adopting any future deployment tooling.
3. Inside the app container, run `umask 077` and `cp -n .env.example .env.local` to create the ignored owner-only template without replacing an existing configuration. Fill it through your secret manager or secure editor, never command-line literals, screenshots or logs. Set `NEXT_PUBLIC_SUPABASE_URL` to the exact DEV project's HTTPS URL and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to its publishable/anon key. Keep `APP_URL=http://localhost:3000`. The template intentionally contains no credentials.
4. Only the two `NEXT_PUBLIC_` values are browser configuration. `SUPABASE_SERVICE_ROLE_KEY` is the DEV project's privileged worker credential; `RECOVERY_SECRET` must be a separately generated random secret of at least 32 bytes. Keep both server-only and supply them only when using recovery. The Google client secret belongs in Supabase's Google provider settings, not in this app. Restart the dev server after environment changes; rebuild production assets after changing public values.
5. Keep `GRADING_MODE=disabled`, `ALLOW_LOCAL_SIMULATION=false`, approval flags false and both AI budgets zero until the live-grading gates below are completed. Auth, drafts, timing and immutable submission/history do not require a paid model. Submissions stay pending without a worker; a worker invoked while disabled records an ungraded `LIVE_GRADING_DISABLED` failure. Hosted simulation is rejected even if explicitly requested. Do not use simulated scores as a substitute for configuring real AI.

After the Google setup below, select **Continue with Google**. Missing provider configuration shows an unavailable message; it never bypasses authentication. After explicit live-use approval, supply server-only `OPENAI_API_KEY`, set the evaluated `OPENAI_MODEL` and approved budgets/flags, then run `npm run worker` in a second **container** terminal. It calls the recovery endpoint every ten seconds; `npm run worker -- --once` processes at most one due job. Closing the browser does not stop it. Never run a worker against a project you did not intentionally select.

## Google provider setup

There are two distinct redirect boundaries:

| Boundary                                                   | Local app + hosted DEV project                           | Production                                                                                                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Google → Supabase (Google Console authorized redirect URI) | `https://<dev-project-ref>.supabase.co/auth/v1/callback` | `https://<production-project-ref>.supabase.co/auth/v1/callback` (use the exact provider callback shown by Supabase for a custom auth domain) |
| Supabase → app (Supabase redirect allowlist)               | `http://localhost:3000/auth/callback`                    | `https://<app-domain>/auth/callback`                                                                                                         |

1. Create separate DEV and production Google OAuth **Web application** credentials and configure the consent screen. Add the exact Google-to-Supabase redirect above and `http://localhost:3000` as the DEV JavaScript origin. Add your account as a test user while the consent screen is in Testing. Use only basic identity/email/profile scopes, not Gmail or Drive.
2. In the **hosted DEV** project's Supabase Dashboard, enable Google with its client ID/secret. Set Site URL to `http://localhost:3000`, allow exactly `http://localhost:3000/auth/callback`, and disable product email login/signup. Do not add wildcard redirects. `supabase/config.toml` is only the isolated CI stack configuration; changing it does not configure hosted Auth. See [Google provider setup](https://supabase.com/docs/guides/auth/social-login/auth-google) and [redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls).
3. For production, enable Google in Supabase Dashboard with the production credentials. Set Site URL to `https://<app-domain>` and allow only the exact app callback, without wildcard destinations. Disable email signup/login for the product. Set server `APP_URL` to that same origin; paths, queries, credentials and non-local HTTP origins are rejected. Use the production Supabase URL/publishable key; keep service-role/recovery/provider secrets server-only.
4. Sign in from the browser that started the flow: the existing Supabase SSR client stores the PKCE verifier and exchanges the callback code into the usual cookies. Denial, missing/invalid codes and provider failures show bounded messages; provider descriptions and user-supplied return URLs are never reflected.

**Existing accounts:** keep the same Supabase project. Supabase automatically links eligible verified same-email identities; the app never merges users by email or rewrites ownership. Before live rollout, record an existing email account's `auth.users.id` and a saved draft/attempt, sign in with its verified Google identity, confirm the ID and history are unchanged, refresh/reload, then sign out and confirm access is denied. Also verify a different Google account cannot read that history. If Supabase does not link the expected identity, stop and investigate provider verification/identity state; do not create an app-side merge.

**Outstanding manual checks:** hosted DEV provisioning/migration, actual Google consent, existing-account identity linking and production redirects need requester-owned projects/credentials. They cannot be proved by mocked OAuth responses or the isolated CI stack. Do not copy production user data to DEV for a linking test; use authorized test identities, and retain the same project when verifying existing-account continuity. Database/HTTP tests independently check SSR sessions, refresh, logout and cross-user isolation.

## Demonstration flow and durability

- Choose a question, write an answer, select confidence and record any assistance. Use **Resume timer** to start acknowledged timing; **Pause** stops it.
- Edits save to IndexedDB, then to the cloud after two idle seconds or a ten-second checkpoint. The UI distinguishes cloud acknowledgment from a device-only snapshot. **Save to cloud** retries explicitly.
- For another device or isolated browser context, sign in with the same Google account. Only the latest acknowledged revision transfers. A stale write shows both copies, confidence and assistance; selecting a copy never silently merges text.
- Disconnect an already loaded tab to edit locally. Reconnect before submitting. Offline time does not enter totals. A full offline page load is not supported.
- The timer has one server-held owner with a thirty-second lease. Explicit takeover discards the old owner's unacknowledged tail. Browser closure, connection loss and lease expiry can conservatively undercount time.
- Submit confirms an immutable answer. A lost acknowledgment retries the exact payload and idempotency key. A failed or uncertain grade is not a wrong answer. Regrading appends revisions and retains an earlier valid score until a valid correction or explicit invalidation.
- Only isolated loopback CI fixtures enable simulation: `[simulate-failure]` persists a first-generation failure and `[simulate-uncertain]` gives an unscored result. Hosted development cannot enable it. Every simulated grade is labeled and excluded from learning evidence.
- Save and pause before viewing history or signing out. Explicit logout clears local snapshots. Local storage failures are visible; cloud saves remain available. History displays the latest 100 attempts, not a complete export.

## Checks and CI

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

### Isolated CI integration

CI alone installs native Supabase CLI **2.122.0**, Python and the engine client on its ephemeral runner. It starts the full Auth/API/Postgres stack from `supabase/config.toml` and applies migrations/seed locally. This is separate from your hosted DEV project and never uses its credentials. In that isolated job:

```bash
python3 scripts/ci/local-stack.py start
python3 scripts/ci/local-stack.py prepare-test
npm run test:integration:ci
python3 scripts/ci/local-stack.py types
```

Both scripts require `CI=true` before any engine/process work. `prepare-test` checks the pinned native CLI and a real local Unix engine socket, rejects remote/named Docker contexts, and runs only `db reset --local` after validating the exact loopback stack. Each CLI call gets an isolated default Docker config and sanitized environment. It writes an owner-only `.supabase-test.json`; the integration runner consumes it once and rejects stale/non-loopback preparations before SQL. Never generate that receipt from hosted status. There is no developer environment-export or general reset command.

Tests use `psql` through local published ports, not `docker exec`, and start the compiled app on loopback port 3001. A containerized CI app/test invocation may deliberately use Linux host networking to reach those isolated loopback services; normal developer profiles never do. The workflow separately builds both images and starts the socket-free app on bridge networking. Missing preparation, SQL or services fails tests instead of skipping them. Stop workers and avoid parallel writes between reset and testing. Privileged Auth admin-generated verification tokens create isolated test sessions without enabling product email login; they are not Google consent evidence.

SQL preflight and the test process share a sanitized libpq environment with both `PGHOST` and `PGHOSTADDR` pinned to the validated loopback destination. Inherited `PGSERVICE`, `PGHOSTADDR` and other `PG*` settings cannot override it. CI deliberately supplies conflicting `PGHOSTADDR=127.0.0.2`; the real `psql` connection report must still select `127.0.0.1`.

`python3 -m unittest discover -s tests/setup -p 'test_*.py'` checks CI selection and local engine/reset safeguards. CI checks generated-type drift, real Auth, Postgres/RLS, concurrent submission, timer ownership, revision replay, request limits, budget reservations and HTTP recovery. A green isolated test run does not prove hosted project setup, Google consent or paid AI compatibility.

The unit suite covers review graduation at both 30 elapsed UTC days **and** ten consecutive unassisted successes, relapse, neutral unscored outcomes, separate evidence tracks, local-day/DST timing, IndexedDB conflicts and the real SDK using mocked provider transport. Those mocks are not model-quality evidence.

## Deployment and live-grading gates

Ordinary API requests use a verified Supabase user and RLS, never the service-role key. Rubrics stay in a private schema. Only authenticated worker functions can reserve provider cost and append grades. Treat the service-role and recovery credentials as secrets.

Live grading stays disabled until a human completes all of these gates:

1. Review the five candidate question versions, rubrics, prerequisites, neutral vocabulary and all 25 expected assessments. Record reviewer and approval. Reviewed content must use new immutable question/rubric versions; do not edit an exposed version.
2. Run an explicitly approved, budgeted model evaluation. Require no pass/fail reversals, all ambiguous examples unscored and all scores within reviewed ranges. No paid evaluation command is shipped or run in this slice.
3. Approve provider retention/data policy. Do not submit confidential employer content or credentials. The adapter requests `store: false`; this does not establish the provider's complete retention policy.
4. Select and verify a hosted scheduler invoking `POST /api/internal/recover` at least once per minute with `Authorization: Bearer <RECOVERY_SECRET>`. Each invocation processes one job. Verify capacity and request duration for two possible 30-second calls plus finalization within a 90-second lease. A browser poll is not a worker. No hosted scheduler is configured or verified here.
5. Supply server-side credentials, the exact evaluated model snapshot and each approval flag listed in `.env.example`. Set `GRADING_MODE=live`, positive budgets no higher than **100 cents/day** and **2000 cents/month**, and complete the Google/Supabase redirect setup above.

The implemented model adapter is pinned to `gpt-5.4-mini-2026-03-17`; compatibility and quality remain unverified against the live provider. Cost uses the documented $0.75/$4.50 per million input/output tokens and reserves ten cents before each dispatch. Unknown usage retains that reservation. Each generation allows at most three outbound requests, including one repair, with SDK retries disabled. Retry delays are 30 seconds then 120 seconds, or longer provider advice. New generations share global cost caps and a per-user limit of 30 grading requests/hour; an attempt has at most ten generations. A timeout may still incur a provider charge.

Simulation requires an explicit flag and loopback application/database URLs. It rejects hosted-production environments. Never describe simulated scores as assessed mastery or readiness.

## Devcontainer support

Both targets use a digest-pinned official **Ubuntu 26.04** base. The shared `base` stage installs Git, CA certificates, curl, the PostgreSQL client and official Node **24.22.1** binaries, verified against committed x64/arm64 SHA256 values from [the release checksums](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt). Node includes npm **11.19.1**; the build checks both versions. Base, Node and Pixi artifacts are pinned; apt packages still receive Ubuntu repository updates, so rebuilds are not byte-for-byte reproducible. Ubuntu's existing UID/GID 1000 account is renamed to `dhruva`, with home `/home/dhruva`.

The Dockerfile defines build stages, not running containers. `FROM docker.io/library/ubuntu:26.04@… AS base` refers to an external registry image and names the stage `base`. `FROM base AS app` and `FROM base AS personal-tools` create sibling targets from that shared stage. Selecting a build target produces one image; it does not start a second container. All root installation finishes before each target's final `USER dhruva`, which selects an OS account, not an image or stage. See [Docker's multi-stage build guide](https://docs.docker.com/build/building/multi-stage/).

For Linux Docker, the default and `personal` configs let Dev Containers synchronize `dhruva`'s UID/GID to the host. For rootless Podman, select `.devcontainer/podman/devcontainer.json` or `.devcontainer/podman-personal/devcontainer.json`, for example `devcontainer up --workspace-folder . --config .devcontainer/podman/devcontainer.json`. Both set `--userns=keep-id:uid=1000,gid=1000` and disable editor UID rewriting. The numbers are **container** IDs; Podman maps the invoking host user's actual UID/GID to those IDs, even when they differ from 1000. Plain `keep-id` without this mapping can conflict with the image account. Docker does not accept Podman's `keep-id` mode. See [Podman's user namespace documentation](https://docs.podman.io/en/latest/markdown/podman-run.1.html#userns-mode) and [Dev Containers' UID behavior](https://code.visualstudio.com/remote/advancedcontainers/add-nonroot-user).

Every developer profile uses bridge networking with outbound internet and localhost-only port publication. No host networking, engine socket, GPU or TUN is needed for hosted Supabase/Google. The separate CI stack keeps strict loopback test/simulation guards; never substitute a hosted URL to bypass them. WSL/rootless Podman/editor ownership behavior remains a manual platform check; Linux Docker validation is not proof of it. Never add engine socket mounts to an app or personal config.

### Optional personal tools

Explicitly select `.devcontainer/personal/devcontainer.json` for Docker or `.devcontainer/podman-personal/devcontainer.json` for rootless Podman. Both build `personal-tools`: unprivileged Bubblewrap, socat, slirp4netns, Python/venv, SSH client and Pixi **0.55.0**, plus named editor/Copilot/Codex state volumes. Only Pixi's binary is copied from its digest-pinned [official multiarch image](https://pixi.sh/latest/deployment/container/) into `dhruva`'s owned `~/.pixi/bin`, which is on PATH. This avoids a mutable installer script, custom Pixi architecture logic and `/root` paths. Authentication for those tools is your own opt-in; no credentials are copied from the host. Existing state volumes from a different container user may need a one-time ownership migration; they are not automatically deleted or recursively reassigned.

Other personal integrations require a **local-only** config derived from this optional config:

- Add `"source=${localEnv:HOME}/.ssh,target=/home/dhruva/.ssh,type=bind,readonly"` only when you intentionally want host SSH files available. Prefer an agent forwarded by your editor; confirm host path and permissions first.
- Add only the personal project or Windows path mounts you actually use, sourced from your own `${localEnv:HOME}` or explicit environment variables. The baseline never requires `/mnt/c` or another user's home.
- For NVIDIA CDI, add `"--device=nvidia.com/gpu=all"` only after configuring the host driver/CDI. For a tool that really needs TUN, add `"--device=/dev/net/tun"` only after checking its permission requirements. Neither is required or enabled for study, Supabase, Python, Pixi or agent tools. Unprivileged sandbox tools remain subject to host user-namespace/AppArmor policy; this config grants no privileged mode, extra capabilities or sudo.

No optional configuration needs or authorizes an engine socket.

## Design sources

The original [implementation specification](docs/swe-trainer-implementation-specification.pdf) and the approved [architecture amendments](docs/architecture-proposal.md) define the product direction. The documents in `docs/` preserve their original documentation-stage wording. This README describes what this implementation actually runs.
