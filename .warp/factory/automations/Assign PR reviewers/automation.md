---
triggers:
    - provider: github
      event: pull_request_ready
      filter:
        labels:
            - factory:sweprep
        repos:
            - dhruvapathak-personal/sweprep
---
Inspect the files and ownership boundaries changed by the pull request or merge request that triggered this automation. Use repository ownership rules and recent contribution history to select the smallest appropriate reviewer set, then request those reviewers. Do not approve the change or perform a separate code review. If ownership is ambiguous, leave the reviewer set unchanged rather than guessing.
