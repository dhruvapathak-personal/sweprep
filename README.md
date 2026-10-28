# SWE Trainer

MVP 1 is a text-answer study loop: Google-only sign-in, five candidate questions, cloud and local drafts, explicit conflict resolution, acknowledged timing, immutable submissions, durable grading recovery and history.

**This is a development build, not a validated interview assessment.** All five questions and 25 example assessments await human review. No live model evaluation or paid provider call has been performed. Voice, vocabulary practice, adaptive sessions, charts, offline question loading and PWA installation are not implemented.

## Local setup

Normal development connects the app container to a **requester-owned, isolated hosted DEV Supabase project**. All project dependencies, app commands and optional personal tools run in containers. The WSL/Linux host needs only core services such as Podman, Git, SSH and the editor/Dev Containers client: no host Node, npm, Python or Supabase CLI installation. Neither profile uses a host lifecycle client; only the personal profile mounts an engine socket for Container MCP.

Developer workflows support **rootless Podman only**, not Docker. Set your Dev Containers client's host engine path to `podman` and select `.devcontainer/personal/devcontainer.json` for interactive development. This profile builds `dev`, matches the Linux/WSL host's numeric UID/GID and requires the SSH paths described under [Optional personal tools](#optional-personal-tools). The client needs to control the host engine; the resulting app container does not, except for the explicitly enabled Container MCP described below. `postCreateCommand` runs `npm ci`. The default `.devcontainer/devcontainer.json` instead selects `release` without host-ID synchronization; it is not the personal development entry point. After completing the hosted project/environment and Google setup below, run inside the personal container:

```bash
npm ci
npm run dev
```

The personal profile also loads [the workspace MCP configuration](.vscode/mcp.json). Its Filesystem and Git servers are limited to this repository; Playwright runs Chromium; Container MCP uses the host Podman socket. GitHub and Supabase connect to their hosted MCP servers using VS Code OAuth; Supabase is configured read-only. Complete authentication in VS Code and select only the intended DEV Supabase project. The local servers and Playwright's Chromium runtime are installed into the `dev` image during its build. Use this MCP configuration with the personal profile; the release image does not include the local packages or mount the Podman socket.

Node **24.x** is selected by `.nvmrc`, CI and the package engine requirement. Use the npm bundled with Node; npm is not versioned or upgraded separately. CI selects the latest Node 24 release, and `npm ci` installs the locked project dependencies. Each profile uses bridge networking and publishes container port 3000 only at host `127.0.0.1:3000`; the app listens on `0.0.0.0` inside the container. Open http://localhost:3000. Ordinary outbound HTTPS/DNS reaches hosted Supabase and Google without host networking. Do not open two profiles on the same port.

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

### Opt-in hosted-service smoke tests

After confirming `.env.local` points to your isolated hosted DEV project and the OpenAI live-grading approval flags and budgets are intentionally enabled, run:

```bash
RUN_LIVE_SERVICE_TESTS=true npm run test:live-services
```

These tests are excluded from normal `npm test` and CI. They read one hosted question ID with the service-role key, check the hosted Google provider settings and start a PKCE authorization request far enough to confirm Supabase redirects to Google's authorization endpoint, then make one Responses API call using only synthetic arithmetic content. No hosted records are written. The OpenAI call can incur a charge; its actual cost is checked against the configured ten-cent reservation. Do not run these tests against production.

The OAuth smoke test does not complete Google consent, exchange a real callback code, prove existing-account identity linking, or validate production redirects. Those still require the manual browser checks above.

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

Both targets use the official **Ubuntu 26.04** base tag without a digest pin. The shared `base` stage contains runtime dependencies: CA certificates, libstdc++ and Node installed system-wide through NodeSource's signed **24.x** apt repository. Curl is installed only temporarily to configure Node, then purged in the same layer. The `nodejs` package includes compatible npm; there is no separate npm installation or version pin, Node image copy, or per-user version manager. Git, curl and the PostgreSQL client are installed only in `dev`. The `dev` target also installs pinned versions of the Filesystem, Playwright and Podman MCP packages, the Git MCP from a pinned source revision, and Chromium plus its OS dependencies. Use `podman build --no-cache --pull=always` when rebuilding to refresh Ubuntu and rerun installation for the latest Node 24 package, MCP dependencies and Pixi. Pulling the base image alone does not invalidate cached installation layers. Ubuntu, Node, Pixi and apt packages can receive updates, so rebuilds are not byte-for-byte reproducible. Ubuntu's existing UID/GID 1000 account is renamed to `dhruva`, with home `/home/dhruva`.

The Dockerfile defines build stages, not running containers. `FROM docker.io/library/ubuntu:26.04 AS base` refers to an external registry image and names the stage `base`. `FROM base AS release` and `FROM base AS dev` create sibling targets from that shared stage. Selecting a build target produces one image; it does not start a second container. The final targets define their own commands: `release` runs `npm start`, while `dev` runs `sleep infinity` for interactive sessions. `release` is currently a runtime image, not a self-contained application artifact: it requires the application, installed dependencies and `npm run build` output mounted at `/workspace/sweprep`, as CI does. The default Dev Container profile selects `release`, keeps the image account's IDs and runs `npm ci` after creation; its workspace permissions must be prepared for that account separately. Only `.devcontainer/personal/devcontainer.json` selects `dev` and mounts persistent editor/agent state. All root installation finishes before each target's final `USER dhruva`, which selects an OS account, not an image or stage. See [Podman's build target option](https://docs.podman.io/en/latest/markdown/podman-build.1.html#target-stage).

The personal profile combines plain `--userns=keep-id` with `updateRemoteUserUID: true`. Podman maps the invoking host user's UID/GID to the **same numeric IDs** inside the container, not fixed container IDs. On Linux/WSL, Dev Containers updates the named `dhruva` account to those host IDs before creating the container. Keep both settings together and rebuild after changing host identity. After opening, compare `id -u` and `id -g` inside and outside the container, and check that a workspace file created inside retains the host user's ownership. If the IDs differ, stop and check the client's UID-update log for existing account/group collisions. The default release profile deliberately sets `updateRemoteUserUID: false`; it does not promise host-matched ownership. See [Podman's user namespace documentation](https://docs.podman.io/en/latest/markdown/podman-run.1.html#userns-mode) and [Dev Containers' UID behavior](https://code.visualstudio.com/remote/advancedcontainers/add-nonroot-user).

Every developer profile uses bridge networking with outbound internet and localhost-only port publication. The default release profile has no engine socket. The personal profile deliberately mounts the host's rootless Podman socket at `/run/podman/podman.sock` for Container MCP; this gives the MCP server control of containers, images, networks and volumes available to the host user, and may permit mounts of files that user can access. Enable the host's rootless socket before creating the personal container (for example, `systemctl --user enable --now podman.socket`) and verify `$XDG_RUNTIME_DIR/podman/podman.sock` exists. Use Container MCP only with trusted agent instructions and work. GitHub MCP uses GitHub's hosted OAuth server; Supabase MCP uses its hosted OAuth server with read-only access. Authenticate those servers in VS Code and select only the intended DEV Supabase project. The filesystem and Git servers are restricted to this workspace. The separate Docker-based CI stack keeps strict loopback test/simulation guards; it does not establish Docker developer support. Never substitute a hosted URL to bypass those guards. WSL/rootless Podman/editor ownership behavior remains a manual platform check; Docker validation is not proof of it.

### Optional personal tools

The `dev` target grants `dhruva` passwordless sudo inside the container; `release` does not install or grant sudo. This does not grant additional container capabilities or host root access. Iptables is not installed.

The personal profile builds `dev`, which adds Git, curl, the PostgreSQL client, unprivileged Bubblewrap, socat, slirp4netns, Python/venv, SSH client, the local MCP servers and Playwright Chromium, and the latest Pixi. It mounts named editor/Copilot/Codex state volumes, the host SSH agent socket at `SSH_AUTH_SOCK`, and the host's `~/.ssh/known_hosts` and `~/.ssh/id_ed25519.pub` read-only. Before opening it, start your host SSH agent, export `SSH_AUTH_SOCK` and confirm those two files exist. The forwarded agent permits use of the host's loaded SSH identities; no private-key file is mounted. If you do not want these integrations, use a local-only copy of the personal config without its SSH mounts and related `remoteEnv` entries. Pixi's [official installer](https://pixi.sh/install.sh) installs the executable system-wide in `/usr/local/bin`, without copying from another image or modifying shell startup files. Installer telemetry is disabled. `PIXI_HOME` remains `dhruva`'s writable `~/.pixi`, and `~/.pixi/bin` stays on PATH for tools installed with `pixi global install`. Authentication for editor/agent tools is your own opt-in. Existing state volumes from a different numeric UID/GID may need a one-time ownership migration; they are not automatically deleted or recursively reassigned.

Other personal integrations require a **local-only** config derived from this optional config:

- Add `"source=${localEnv:HOME}/.ssh,target=/home/dhruva/.ssh,type=bind,readonly"` only when you intentionally want host SSH files available. Prefer an agent forwarded by your editor; confirm host path and permissions first.
- Add only the personal project or Windows path mounts you actually use, sourced from your own `${localEnv:HOME}` or explicit environment variables. The baseline never requires `/mnt/c` or another user's home.
- For NVIDIA CDI, add `"--device=nvidia.com/gpu=all"` only after configuring the host driver/CDI. For a tool that really needs TUN, add `"--device=/dev/net/tun"` only after checking its permission requirements. Neither is required or enabled for study, Supabase, Python, Pixi or agent tools. Unprivileged sandbox tools remain subject to host user-namespace/AppArmor policy; this config grants no privileged mode or extra capabilities. Passwordless sudo in `dev` does not bypass those host restrictions.

The personal Container MCP socket mount is the sole exception to the baseline's no-engine-socket policy. Do not copy it into other app or release configurations.

## Design sources

The original [implementation specification](docs/swe-trainer-implementation-specification.pdf) and the approved [architecture amendments](docs/architecture-proposal.md) define the product direction. The documents in `docs/` preserve their original documentation-stage wording. This README describes what this implementation actually runs.

The [Factory and Copilot agent guide](docs/factory-definition.md) explains the five translated Copilot agents and the preserved Factory source baseline. It does not deploy a live Factory.
