---
triggers:
    - provider: github
      event: issue_labeled
      filter:
        labels:
            - factory:sweprep
        repos:
            - dhruvapathak-personal/sweprep
    - provider: github
      event: issue_created
      filter:
        labels:
            - factory:sweprep
        repos:
            - dhruvapathak-personal/sweprep
---

