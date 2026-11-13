# VTID-05797 — acceptance evidence

Scope: CI wiring for the VTID-05622/05670 staging group-chat check. Sparring record: `plan-sparring.md` (abaf654db295dd732, converged, owner Gate 1 "yes").

| Criterion | Evidence |
|---|---|
| The group pair reaches only the Playwright env | `workflow.test.cjs` (a), `node --test scripts/ci/staging-verify/workflow.test.cjs`: 11 pass, 0 fail |
| The pair is deleted from `process.env` at verify start | `workflow.test.cjs` (b) |
| The shared `TEST_USER_*` pair is unchanged | `workflow.test.cjs` (c) |
| Workflow passes the secrets to the verify step only | `workflow.test.cjs` (d) |
| Full staging-verify suite still green | `node --test` on `scripts/ci/staging-verify/*.test.cjs` and `*.test.mjs`: 123 pass, 0 fail |

Not yet proven on staging: the group check itself. It runs after merge (STAGING-VERIFY community-app on the merge commit), and only once the owner has confirmed the three pre-merge items in the PR body.
