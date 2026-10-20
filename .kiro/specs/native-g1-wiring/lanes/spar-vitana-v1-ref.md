---
lane: spar-vitana-v1-ref
state: done
next_actor: kiro
depends_on: []
executor: claude
reviewer_seat: claude
pr: https://github.com/exafyltd/vitana-platform/pull/4201
paths:
  - .github/workflows/PLAN-SPAR.yml
  - scripts/collab/plan-spar.mjs
  - scripts/collab/plan-spar.test.mjs
updated: 2026-10-20T08:41Z
vtid: VTID-05252
---
# Give the sparring partner a vitana-v1 ref (R1-F1) — DONE (PR #4201, merged `fa73aabd0`)

**Governance-path lane (`executor: claude`): `.github/workflows/**` and `scripts/collab/**`.** Native plans
premise on code in **vitana-v1** (`apps/mobile/**`), but the sparring session was created pinned only to
`vitana-platform`, so the partner could not read or verify any native `file:line` claim (R1-F1/R1-F2 on
`native-g1-wiring`).

**The fix (merged).** The gateway already accepts `extra_refs`
(`services/gateway/src/services/plan-sparring/plan-sparring-service.ts` ~L106–116 validates each key against
`PLAN_SPARRING_REPOS`) and `github-tools.ts` already allowlists `exafyltd/vitana-v1` (`PLAN_SPARRING_REPOS`,
`planSparringGithubToken()`), so no gateway change was needed:
1. `.github/workflows/PLAN-SPAR.yml` resolves the vitana-v1 `main` SHA
   (`gh api repos/exafyltd/vitana-v1/commits/main --jq .sha`) and passes `--extra-ref-vitana-v1`.
2. `scripts/collab/plan-spar.mjs` forwards a valid 40-hex SHA as
   `extra_refs: { 'exafyltd/vitana-v1': <sha> }` in `client.create`, only when provided.
3. `scripts/collab/plan-spar.test.mjs` proves `extra_refs` is forwarded when set, omitted when null/empty.

**Takes effect only for sessions whose PLAN-SPAR base checkout contains the merge.** PLAN-SPAR checks out
`pull_request.base.sha`; a plan branch must be brought up to date with `main` (this merge) before its next
session sees the fix. The first session created after this merge on an un-updated branch (`8e2ff780`) still
could not read vitana-v1 — confirming the base-sha dependency.

## Log
### 2026-10-19T20:15Z · kiro-202610151913-51bd · ready → done (merged)
PR #4201 merged (`fa73aabd0`); plan-spar.test.mjs 10/10, all 8 PR checks green incl. Lane scope.
### 2026-10-19T20:40Z · kiro-202610151913-51bd · merge-resolve
Resolved an add/add conflict when merging main into the plan branch (the lane file exists both here and on
main via #4201). Kept `state: done`.

### 2026-10-20T08:41Z · ci-plan-spar · ready (VTID allocated)
VTID-05252 allocated after policy approval (converged-auto-v1).
