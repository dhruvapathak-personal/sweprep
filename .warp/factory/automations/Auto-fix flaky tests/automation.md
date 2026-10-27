---
triggers:
    - provider: github
      event: pull_request_merged
      filter:
        labels:
            - factory:sweprep
        repos:
            - dhruvapathak-personal/sweprep
---
Inspect the triggering pull request’s repository and base branch. This automation requires GitHub merge-queue CI runs.

When a pull request merges in the configured repository, verify its merged state and base branch. Before acknowledgements, delegation, reading source code, downloading logs, searching for duplicates, or rerunning checks, inspect its merge-queue timeline and CI metadata. Limit discovery to its last five queue intervals ending no later than the merge time, and at most five recent candidate runs. Match merge_group runs to this exact PR and base branch using their queue branch and commit metadata; do not attribute another queued PR’s failures to it. Check all failed or timed-out jobs, including earlier attempts when the latest attempt passed. If there are no candidates, stop without notifications or broader searches. If evidence cannot be read or attributed reliably, report the blocker in this task instead of assuming there were no failures.

For one credible candidate, inspect the failed jobs’ logs and compare failing and passing attempts, source revisions, and code changes before merge. Trace aggregate job failures such as Lints to the underlying failed job rather than treating the aggregate as a separate root cause. Consider test, lint, typecheck, build, codegen, or other CI failures that admit a durable repository-code fix. A passing retry alone is not proof of a flake. Skip setup, infrastructure, network, or runner noise, failures resolved by code changes before merging, and problems already fixed on the current base branch. Proceed only with evidence of an unresolved repository-code root cause. Check for existing fixes or Factory tasks before starting work and again before opening a PR to avoid duplicates. Fix the root cause without disabling checks or weakening test assertions, validate with the relevant repository checks and focused repeated runs for suspected flakes, and open a separate fix PR from the current tip of the triggering PR’s base branch. Keep the work in this automation’s task; treat the source PR, issues, and original conversations and Slack threads as read-only. Do not resume the source task, use computer use, or merge the fix. Include links to the source PR, failed run/job, and any passing evidence in the fix PR and handoff.

After deciding to fix the failure, trace the failing test or relevant code through git history and its introducing PR, following renames and moves. Request review and approval from the human who introduced the relevant code, not its latest editor, merge committer, or the triggering PR’s author. If that creator is a bot or factory agent, request review from the human whose most recent approval of the introducing PR was still valid when it merged. Use verified GitHub logins from commit, PR, and review metadata. If the responsible code or a human owner cannot be established, leave the reviewer unset and explain the missing ownership information. Include the introducing PR or commit and reviewer-selection reason in the handoff.
