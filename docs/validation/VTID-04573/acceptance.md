# VTID-04573: staging gateway GitHub token returns 401, repointed to vitana/github/pat

Since about 10:00 UTC on 2026-09-25, every GitHub call from the staging gateway returns `401 Unauthorized`:

- Opening the PR when a held Dev Autopilot execution is approved (execution ee04be49, VTID-04531).
- The Operator Console's repository reads: CLAUDE.md, the change log, and the open PR list.

The task definition wiring did not change. The staging gateway, the production gateway and the executor all use the same execution role, `vitana-ecs-task-execution-role`. Secret metadata, read from this session without reading any secret value:

| Secret | Used by | Last set | State |
|---|---|---|---|
| `vitana/github/token` | staging and production gateways | 2026-08-26 09:54 UTC | 401 since ~2026-09-25 10:00 |
| `vitana/github/pat` | autopilot executor | 2026-07-24 | executor pushed `dev-autopilot/ee04be49` with it at 09:34 on 2026-09-25 |

The failure window runs from 09:05 (the PUBLISH dispatch succeeded) to ~10:43 (the approval returned 401). Exactly 30 days after the last write is 2026-09-25 09:54, inside that window. This is consistent with a fine-grained token with 30-day expiry. The session's IAM user cannot call `GetSecretValue`, so this is an inference and was not tested directly.

## Acceptance criteria

AC-1 The staging deploy resolves `SEC_GITHUB_TOKEN` from `vitana/github/pat`.
TEST: services/gateway/test/vtid-04573-staging-github-token-secret.test.ts

AC-2 The token is still wired as `GITHUB_SAFE_MERGE_TOKEN` through a `valueFrom` secret reference, never a plain value.
TEST: services/gateway/test/vtid-04573-staging-github-token-secret.test.ts

## Not covered here

The production gateway (`vitana-gateway-awsdr`) still reads `vitana/github/token`. The durable fix is for the owner to generate a new token and write it to that secret. GitHub has no API for creating personal access tokens, and this session cannot write secret values. Production then needs a restart, for example an env-only dispatch of `AWS-PROD-DEPLOY-GATEWAY.yml`.

OASIS_IMPACT: no
