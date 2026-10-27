# Factory source and Copilot agents

This repository contains two distinct layers: five translated Copilot custom-agent profiles under `.github/agents/`, and an unchanged Warp Factory source baseline under `.warp/factory/`. The profiles adapt the original roles for Copilot; the archive preserves their provenance. Neither layer deploys or updates a live Factory.

## Choose a Copilot role

- [sweprep-foreman](../.github/agents/sweprep-foreman.agent.md), from the [Foreman source](../.warp/factory/agents/sweprep%20Foreman%20Agent/agent.md): routes work, batches questions, and enforces human gates.
- [sweprep-triage](../.github/agents/sweprep-triage.agent.md), from the [Triage source](../.warp/factory/agents/sweprep%20Triage%20Agent/agent.md): researches causes and prepares issue content.
- [sweprep-spec](../.github/agents/sweprep-spec.agent.md), from the [Spec source](../.warp/factory/agents/sweprep%20Spec%20Agent/agent.md): interviews, records decisions, and writes a spec for approval.
- [sweprep-implement](../.github/agents/sweprep-implement.agent.md), from the [Implement source](../.warp/factory/agents/sweprep%20Implement%20Agent/agent.md): makes and verifies the approved change on the existing spec PR when present.
- [sweprep-review](../.github/agents/sweprep-review.agent.md), from the [Review source](../.warp/factory/agents/sweprep%20Review%20Agent/agent.md): returns advisory findings without editing code or posting a review.

Each profile includes its role boundaries and reads the local repository instructions explicitly. Quality and review standards are adapted inline, because custom subagents do not always inherit repository-wide instructions. The archived runtime skills are not dependencies of these profiles.

### Selection and handoff

For normal GitHub cloud-agent discovery, [GitHub documents merging profiles into the default branch](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents). A human must review and merge this PR; do not merge merely to test discovery. Then select this repository and the named custom agent in the agents interface.

In [Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli), load this checkout, restart the client after adding profiles, and select a role with `/agent` or `copilot --agent sweprep-foreman`. In a [supported IDE](https://code.visualstudio.com/docs/copilot/customization/custom-agents), open the checkout and select its custom agent. Availability depends on the client version, account access, and repository permissions.

Give the selected role the exact request, issue text or link, branch/PR context, evidence, acceptance criteria, and unresolved choices. The foreman can invoke other named roles only if the host provides that capability. Otherwise it returns a complete manual brief for the user to pass to the next selected role. There is no durable autonomous workflow or cross-session messaging guarantee.

VS Code supports client-specific `handoffs` buttons, but GitHub cloud ignores that property. These portable profiles omit it and use named-role selection or supported delegation instead. No optional MCP or browser integration is configured here; adding one needs a separate authorized setup task.

### Tools and permissions

Profiles use only the documented `name`, required `description`, and `tools` properties. Models inherit the host default; no Warp model identifiers, MCP server IDs, `agentType`, client-specific handoff fields, or credentials are copied into active profiles.

- All roles enable `read` and `search`.
- Foreman also enables `agent` for supported delegation.
- Spec also enables `edit` for specification files.
- Implementation also enables `edit` and `execute` for changes, checks, and authorized GitHub CLI operations.
- Triage and review have no editing, shell, or GitHub writing tools. Triage supplies issue payloads; review supplies findings. Foreman and spec return publication payloads rather than pretending to post them.

These are [Copilot tool aliases](https://docs.github.com/en/copilot/reference/custom-agents-configuration), not a grant of repository permissions. Authentication and host permissions remain necessary; shell execution is not itself a security boundary. Missing tools, external issue content, authentication, or approval require an honest limitation and manual handoff, not bypasses or invented results.

### What is not translated

The twelve hosted automations, five scorer execution/sampling/self-improvement configurations, runner image and credentials, Slack subscriptions, managed identities, and live registration are not recreated. No Actions workflows, webhooks, integrations, background loops, or deployment setup are added. Copilot profiles do not offer automatic Factory equivalence.

The translated roles keep GitHub Issues in `dhruvapathak-personal/sweprep`, approved specifications before implementation when a spec exists, same-PR revisions, report-only review, and human merge gates. They use the current Copilot session, not Slack or Warp messaging. Native Factory routing labels are not added automatically because they can start separate live automations.

## Preserved source baseline

The initial archive copies all 30 tracked files from the separate `sweprep-factory-repo` checkout at commit `859894ead7c94553cd4a0b9bb5a86cca2c870a50`, preserving relative paths, bytes, and Git file modes under `.warp/factory/`:

- [Factory configuration](../.warp/factory/factory.yaml), five [agents](../.warp/factory/agents/), twelve [automations](../.warp/factory/automations/), and the [default runner](../.warp/factory/runners/default.yaml).
- Five [scorers](../.warp/factory/scorers/) and five [shared skill documents](../.warp/factory/skills/): code quality, code review, GitHub, Slack, and UI verification.
- The executable [GitHub review-thread helper](../.warp/factory/skills/github/scripts/resolve-threads).

No benchmarks, webhooks, or agent-local skills were tracked. The import excludes Git metadata, credentials, untracked files, runtime metadata, and event payloads. Provenance, usage notes, and the [repository-wide Copilot entrypoint](../.github/copilot-instructions.md) remain outside the archive.

Archived prompts, automation bodies, rubrics, and skills are source artifacts, not instructions to execute wholesale. They retain native Factory checkout/review assumptions, runtime paths, integration identifiers, and attribution logic that do not govern this GitHub copy. Review future edits through GitHub PRs; retain this pin as the initial baseline and document later changes separately.

## Validation boundary

Copilot profile format, supported aliases, local references, and archive fidelity can be checked statically. This import has not been loaded in an authenticated Copilot host. Runtime loading, selection, delegation, permission behavior, and approval-gate smoke tests remain unverified; exercise those in the intended host before relying on the workflow.

The server-backed Factory Files validator targets only `.warp/factory/`, not `.github/agents/`. A parser/state-independent pass does not verify live models, environments, secrets, runners, MCP servers, integrations, or aliases, and does not prove the configuration can apply. Report diagnostics without silently rewriting the faithful archive. Live registration or deployment needs separate explicit authorization.
