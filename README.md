# SWE Trainer

MVP 1 is a text-answer study loop: Google-only sign-in, five candidate questions, cloud and local drafts, explicit conflict resolution, acknowledged timing, immutable submissions, durable grading recovery and history.

**This is a local demonstration, not a validated interview assessment.** All five questions and 25 example assessments await human review. No live model evaluation or paid provider call has been performed. Voice, vocabulary practice, adaptive sessions, charts, offline question loading and PWA installation are not implemented.

## Local setup

The current implementation uses **Linux host networking**. The host runs the full Supabase stack; the app container uses its published loopback ports without an engine socket or engine client. Moving the project-specific Supabase CLI into a container is pending a tooling-topology decision; the host-native instructions below describe the current code, not the final agreed design. Host Node/npm is not required. Routine tests make no paid API calls. WSL2/rootless Podman setup is documented but not verified here.

On host WSL Ubuntu, install rootless Podman, Python **3.10+**, and the **standalone native Supabase CLI 2.122.0**. Install the CLI release binary or Linux package from [the official release](https://github.com/supabase/cli/releases/tag/v2.122.0), verify its published checksum, and put `supabase` on the host PATH. Do not use `npx`, npm, or a containerized CLI on the host. Verify `python3 --version`, `supabase --version`, and `podman info` before proceeding.

The host CLI talks to the host user's rootless Podman API. Enable it and point the CLI at that local Unix socket in the **host terminal only**:

```bash
systemctl --user enable --now podman.socket
unset DOCKER_CONTEXT
export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/podman/podman.sock"
python3 scripts/local-stack.py start
python3 scripts/local-stack.py reset
python3 scripts/local-stack.py env
```

Before every CLI invocation, the helper requires a real local Unix engine socket. It rejects TCP/SSH engine URLs and named `DOCKER_CONTEXT` selections. Without `DOCKER_HOST`, only the default Docker context/socket is accepted; if your saved Docker context is named, explicitly select the intended local socket instead. Each CLI subprocess receives a pinned `DOCKER_HOST`, an isolated default Docker config and no inherited Docker TLS/context or libpq overrides. This applies to start, stop, status, reset, configuration export and type generation, not only destructive commands.

The helper also checks the native CLI version, suppresses credentials, and refuses non-loopback status before resets or configuration export. `reset` deletes local study data. `env` creates `.env.local` with owner-only permissions and refuses to overwrite any existing file. It enables local simulation with zero provider budgets. Never commit or share that file.

Open this repository with your Dev Containers client using `.devcontainer/devcontainer.json` for Linux Docker or `.devcontainer/podman/devcontainer.json` for rootless Podman (set the client's host engine path to `podman`). The client needs to control the host engine; the resulting app container does not. `postCreateCommand` runs `npm ci`. Inside the app container:

```bash
npm ci
npm run dev
```

Node **24.22.1** and its bundled npm **11.19.1** match `.nvmrc`, CI and the lockfile. No global npm override is needed. Open http://localhost:3000 and select **Continue with Google** after completing provider setup below. Until then, the actual login screen shows an unavailable message; it does not bypass authentication. Mailpit is not a product login path.

In a second terminal, run `npm run worker`. This independent runner invokes the authenticated recovery endpoint every ten seconds. Closing the study tab does not stop it. Without the runner, submitted answers remain safely pending. `npm run worker -- --once` processes at most one due job.

Host lifecycle commands stay in the host terminal: `python3 scripts/local-stack.py stop`, `reset`, `env`, `prepare-test`, and `types`. Run dependency, app, worker and test commands only inside the app container. If the host engine is Docker instead of Podman, leave the default local context selected or explicitly export `DOCKER_HOST=unix:///var/run/docker.sock` with `DOCKER_CONTEXT` unset; do not export a Podman socket for Docker.

## Google provider setup

There are two distinct redirect boundaries:

| Boundary                                                   | Local                                     | Production                                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Google → Supabase (Google Console authorized redirect URI) | `http://127.0.0.1:54321/auth/v1/callback` | `https://<project-ref>.supabase.co/auth/v1/callback` (use the exact provider callback shown by Supabase for a custom auth domain) |
| Supabase → app (Supabase redirect allowlist)               | `http://localhost:3000/auth/callback`     | `https://<app-domain>/auth/callback`                                                                                              |

1. Create Google OAuth **Web application** credentials and configure the consent screen. Add the exact Google-to-Supabase redirect above; add your account as a test user while the consent screen is in Testing. Use only basic identity/email/profile scopes, not Gmail or Drive. Use separate local and production credentials.
2. For local use, securely supply `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` to the **host CLI environment** using your secret manager. Do not paste credentials into shell history, the repository, screenshots or logs. In `supabase/config.toml`, set only `[auth.external.google].enabled` to `true`, then stop/start the host stack to apply it. Keep the credential-free default `false` in commits. No Google secret enters the app's public environment.
3. For production, enable Google in Supabase Dashboard with the production credentials. Set Site URL to `https://<app-domain>` and allow only the exact app callback, without wildcard destinations. Disable email signup/login for the product. Set server `APP_URL` to that same origin; paths, queries, credentials and non-local HTTP origins are rejected. Use the production Supabase URL/publishable key; keep service-role/recovery/provider secrets server-only.
4. Sign in from the browser that started the flow: the existing Supabase SSR client stores the PKCE verifier and exchanges the callback code into the usual cookies. Denial, missing/invalid codes and provider failures show bounded messages; provider descriptions and user-supplied return URLs are never reflected.

**Existing accounts:** keep the same Supabase project. Supabase automatically links eligible verified same-email identities; the app never merges users by email or rewrites ownership. Before live rollout, record an existing email account's `auth.users.id` and a saved draft/attempt, sign in with its verified Google identity, confirm the ID and history are unchanged, refresh/reload, then sign out and confirm access is denied. Also verify a different Google account cannot read that history. If Supabase does not link the expected identity, stop and investigate provider verification/identity state; do not create an app-side merge.

**Outstanding manual checks:** actual Google consent, existing-account identity linking and production redirects need requester-owned Google credentials. They cannot be proved by mocked OAuth responses or password fixtures. Database/HTTP tests independently check SSR sessions, refresh, logout and cross-user isolation.

## Demonstration flow and durability

- Choose a question, write an answer, select confidence and record any assistance. Use **Resume timer** to start acknowledged timing; **Pause** stops it.
- Edits save to IndexedDB, then to the cloud after two idle seconds or a ten-second checkpoint. The UI distinguishes cloud acknowledgment from a device-only snapshot. **Save to cloud** retries explicitly.
- For another device or isolated browser context, sign in with the same Google account. Only the latest acknowledged revision transfers. A stale write shows both copies, confidence and assistance; selecting a copy never silently merges text.
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
```

Before **each** integration run, stop recovery workers and run on the **host**:

```bash
python3 scripts/local-stack.py prepare-test
```

Then run **inside the app container**:

```bash
npm run test:integration
```

`prepare-test` performs a clean CLI reset and writes a private `.supabase-test.json` handoff. The runner consumes it once, rejects preparations older than 30 minutes or non-loopback endpoints, checks SQL reachability, and starts the compiled app on port 3001. Tests use `psql` over the local published database port, not `docker exec`; no engine access is needed. Missing preparation, SQL or services fails the run rather than skipping tests. Do not run a worker, app writes or parallel suites between reset and testing. Privileged Auth admin-generated verification tokens create isolated test sessions without enabling product email login; they are not Google consent evidence.

SQL preflight and the test process share a sanitized libpq environment with both `PGHOST` and `PGHOSTADDR` pinned to the validated loopback destination. Inherited `PGSERVICE`, `PGHOSTADDR` and other `PG*` settings cannot override it. CI deliberately supplies conflicting `PGHOSTADDR=127.0.0.2`; the real `psql` connection report must still select `127.0.0.1`.

On the host, `python3 scripts/local-stack.py types` regenerates database types using the native CLI. `python3 -m unittest discover -s tests/setup -p 'test_*.py'` checks host setup safeguards. CI runs these steps and checks for generated-type drift, in addition to real Auth, Postgres/RLS, concurrent submission, timer ownership, revision replay, request limits, budget reservations and HTTP recovery tests.

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

Linux `--network=host` currently keeps app and Supabase on loopback for tests/simulation; outbound internet alone does not require it. Do not replace loopback with `host.containers.internal`, a LAN address or a hosted URL to bypass safety checks. The Supabase tooling topology remains under review. No WSL, rootless Podman/editor or macOS/Windows Docker Desktop networking validation is claimed. Engine socket environment variables stay host-only; never add them or socket mounts to an app config.

### Optional personal tools

Explicitly select `.devcontainer/personal/devcontainer.json` for Docker or `.devcontainer/podman-personal/devcontainer.json` for rootless Podman. Both build `personal-tools`: unprivileged Bubblewrap, socat, slirp4netns, Python/venv, SSH client and Pixi **0.55.0**, plus named editor/Copilot/Codex state volumes. Only Pixi's binary is copied from its digest-pinned [official multiarch image](https://pixi.sh/latest/deployment/container/) into `dhruva`'s owned `~/.pixi/bin`, which is on PATH. This avoids a mutable installer script, custom Pixi architecture logic and `/root` paths. Authentication for those tools is your own opt-in; no credentials are copied from the host. Existing state volumes from a different container user may need a one-time ownership migration; they are not automatically deleted or recursively reassigned.

Other personal integrations require a **local-only** config derived from this optional config:

- Add `"source=${localEnv:HOME}/.ssh,target=/home/dhruva/.ssh,type=bind,readonly"` only when you intentionally want host SSH files available. Prefer an agent forwarded by your editor; confirm host path and permissions first.
- Add only the personal project or Windows path mounts you actually use, sourced from your own `${localEnv:HOME}` or explicit environment variables. The baseline never requires `/mnt/c` or another user's home.
- For NVIDIA CDI, add `"--device=nvidia.com/gpu=all"` only after configuring the host driver/CDI. For a tool that really needs TUN, add `"--device=/dev/net/tun"` only after checking its permission requirements. Neither is required or enabled for study, Supabase, Python, Pixi or agent tools. Unprivileged sandbox tools remain subject to host user-namespace/AppArmor policy; this config grants no privileged mode, extra capabilities or sudo.

No optional configuration needs or authorizes an engine socket.

## Design sources

The original [implementation specification](docs/swe-trainer-implementation-specification.pdf) and the approved [architecture amendments](docs/architecture-proposal.md) define the product direction. The documents in `docs/` preserve their original documentation-stage wording. This README describes what this implementation actually runs.
