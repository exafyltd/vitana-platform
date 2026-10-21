---
lane: plan-spar-checks
state: ready
next_actor: kiro
depends_on: []
executor: claude
seat: exafyltd
reviewer_seat: claude
paths:
  - .github/workflows/PLAN-SPAR.yml
  - scripts/collab/plan-spar.test.mjs
  - scripts/ci/plan-spar-slot/slot.test.mjs
  - docs/validation/**
updated: 2026-10-21T11:20Z
---
# Lane: plan-spar-checks

Make PLAN-SPAR round commits visible to the merge step on the plan PR head (today a `GITHUB_TOKEN` push
starts no `pull_request` checks, so every merge needed `gh pr update-branch`). **One concrete mechanism:**
after the round-commit push, when `secrets.PLAN_SPAR_PUSH_TOKEN` is empty (the `GITHUB_TOKEN` case), post a
`plan-spar/needs-rebase` commit status on the new bot head via `POST /repos/{owner}/{repo}/statuses/{sha}`
(`GITHUB_TOKEN` carries `statuses: write`); the PM / land step reads that status and runs
`gh pr update-branch` so checks start under a re-push. Re-dispatch/re-run and the Checks API are not
options here (see plan R2-F1). Tasks T1–T2 in `tasks.md`.

`executor: claude` and `PLAN-SPAR.yml` is a **protected gate file**: with `CLAUDE_AVAILABLE=false` it is
blocked on an owner instruction naming this plan before it can merge (surfaced for Gate 2). The repo
secret `PLAN_SPAR_PUSH_TOKEN`, if that path is chosen, is owner config → listed for Gate 2, not set here.
No VTID yet.

## Log

### 2026-10-21T11:20Z · kiro-hotmail-202610210852-0b8e · ready
Lane created with the plan. Scope: PLAN-SPAR.yml + the plan-spar/slot tests + validation docs. Evidence
from inv-rules §7(1) / inv-code §3 / inv-tests §3(C). Flagged protected-gate + the secret-is-owner-config
split. No VTID yet.

### 2026-10-21T12:20Z · kiro-hotmail-202610210852-0b8e · spar s2 round-2 R2-F1 accepted
Committed to one mechanism: on the empty-`PLAN_SPAR_PUSH_TOKEN` push, post a `plan-spar/needs-rebase`
commit status on the new bot head (`POST /repos/{owner}/{repo}/statuses/{sha}`; `GITHUB_TOKEN` has
`statuses: write`); PM/land step reads it and runs `gh pr update-branch`. Rejected the re-run and Checks-API
alternatives (re-run hits the old SHA; Checks API needs `checks:write` the `pull_request_target`
`GITHUB_TOKEN` lacks). Proof test pins that the empty-secret path posts that status on the bot head.
