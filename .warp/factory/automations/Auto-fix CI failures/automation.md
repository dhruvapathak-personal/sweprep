---
triggers:
    - provider: github
      event: workflow_run_completed
      filter:
        conclusions:
            - failure
        labels:
            - factory:sweprep
        repos:
            - dhruvapathak-personal/sweprep
---
For a failed completed GitHub workflow, verify the run and attempt still belong to the current head and no newer attempt exists. Resolve the PR to its existing Factory task and main agent; when one exists, hand off the failure to that agent as a revision and stop instead of starting duplicate work. Skip PRs owned or actively handled by another factory or bot. When ownership is ambiguous, stop. Otherwise, inspect the failed jobs’ logs and fix the root cause on this same branch without disabling checks or weakening test assertions. Skip setup, infrastructure, network, or runner failures that no code change can fix. Run the relevant repository checks, and recheck head, state, ownership, and workflow before pushing. Continue on the existing PR; never open a replacement PR or merge.
