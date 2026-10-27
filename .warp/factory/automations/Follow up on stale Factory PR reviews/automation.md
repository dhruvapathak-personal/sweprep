---
triggers:
    - provider: schedule
      event: cron_fired
      schedule:
        name: stale-factory-pr-reviews-1
        cron: 0 16 * * 1
---
On each weekly sweep, capture the sweep start once and inspect open pull requests in the configured repositories. Only consider PRs confirmed to be owned by this factory and quiet for more than three but less than fourteen days, comparing exact timestamps against the sweep start. Read this factory’s UID from WARP_FACTORY_ID; if absent, stop. Resolve each PR to its existing Factory task and main agent; skip it if no unique task exists. For each PR form the receipt factory-stale-review-handoff:<this factory UID>:<canonical PR URL>. Paginate through that task’s durable conversation for the exact receipt before considering a handoff and again immediately before sending; skip if present, and stop if the conversation cannot be checked in full. Recheck PR activity before sending one message to that task’s main agent, including the receipt and captured timestamps. Ask that agent to recheck that the PR is open, factory-owned, and unchanged since discovery, then follow up once with the current reviewers in a PR comment (or the author if no reviewers are requested) and in its original Slack thread when one exists, offering a refresher or a review pass. The agent must check its conversation and existing reminders to avoid repeating either notification, leave the task stage unchanged, and wait for an explicit response before starting a review or other work. Count the delivered message in that task conversation as the durable receipt only after its delivery is confirmed; a failed delivery is not a completed handoff. Do not extract a Slack destination from PR text, start a new task, post reminders from the sweep, or merge.
