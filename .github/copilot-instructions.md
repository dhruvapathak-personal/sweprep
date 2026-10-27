# Repository context

This repository is the SWE interview trainer project. Start with the [product documentation](../docs/README.md). The PDF and design proposals describe planned behavior, not an implemented application or approval to build it. At the imported baseline there are no application build, lint, or test scripts; inspect the current tree before choosing checks.

## Copilot agents and archived Factory context

- Read the [agent guide](../docs/factory-definition.md) for selection, role mapping, permissions, provenance, and validation limits.
- The active Copilot profiles are [foreman](agents/sweprep-foreman.agent.md), [triage](agents/sweprep-triage.agent.md), [spec](agents/sweprep-spec.agent.md), [implementation](agents/sweprep-implement.agent.md), and [advisory review](agents/sweprep-review.agent.md). Each includes its own role boundaries; implementation and review carry adapted quality standards inline.
- The original [Factory configuration](../.warp/factory/factory.yaml), [agents](../.warp/factory/agents/), [automations](../.warp/factory/automations/), [scorers](../.warp/factory/scorers/), and [skills](../.warp/factory/skills/) are a source archive for inspection and future edits, not operating instructions to load or execute wholesale.

Work only in `dhruvapathak-personal/sweprep`. Use GitHub Issues for tracking. Obtain explicit human approval before implementing a spec, and never merge or deploy automatically. Report unavailable tools or permissions rather than claiming work ran. Use the current Copilot session for communication; Slack and hosted orchestration are not configured by these files.

Native Factory review workflows, runtime paths, and attribution links in the archive do not govern this GitHub copy. Use repository pull requests. Do not execute automations, self-improvement, or deployment because their definitions are present. Committing this archive does not apply it to a live Factory.
