---
triggers:
    - provider: github
      event: issue_mentioned
      filter:
        labels:
            - factory:sweprep
        mentioned:
            - warp
            - warp-factory
        repos:
            - dhruvapathak-personal/sweprep
    - provider: github
      event: pull_request_mentioned
      filter:
        labels:
            - factory:sweprep
        mentioned:
            - warp
            - warp-factory
        repos:
            - dhruvapathak-personal/sweprep
    - provider: github
      event: issue_assigned
      filter:
        assignees:
            - warp
            - warp-factory
        labels:
            - factory:sweprep
        repos:
            - dhruvapathak-personal/sweprep
    - provider: github
      event: pull_request_assigned
      filter:
        assignees:
            - warp
            - warp-factory
        labels:
            - factory:sweprep
        repos:
            - dhruvapathak-personal/sweprep
---

