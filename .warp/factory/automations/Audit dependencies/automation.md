---
triggers:
    - provider: schedule
      event: cron_fired
      schedule:
        name: audit-dependencies-1
        cron: 0 16 * * 1
---
Audit the repository dependency manifests and lockfiles for known security vulnerabilities using the repository-supported package-manager audit commands and advisory sources. Validate that each finding affects a version the repository actually uses. For every confirmed vulnerability with a safe compatible upgrade, update only the necessary dependency and lockfile entries, run the relevant tests and checks, and open a draft pull request or merge request that identifies the advisory, affected version, remediation, and validation. Do not make unrelated dependency updates. If no confirmed vulnerability has a safe upgrade, leave the repository unchanged and do not open a change request.
