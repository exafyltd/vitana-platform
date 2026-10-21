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

Make PLAN-SPAR round commits start checks on the plan PR head (today a `GITHUB_TOKEN` push starts no
`pull_request` checks, so every merge needed `gh pr update-branch`). Either dispatch the checks after the
push or push with a token that triggers them. Tasks T1–T2 in `tasks.md`.

`executor: claude` and `PLAN-SPAR.yml` is a **protected gate file**: with `CLAUDE_AVAILABLE=false` it is
blocked on an owner instruction naming this plan before it can merge (surfaced for Gate 2). The repo
secret `PLAN_SPAR_PUSH_TOKEN`, if that path is chosen, is owner config → listed for Gate 2, not set here.
No VTID yet.

## Log

### 2026-10-21T11:20Z · kiro-hotmail-202610210852-0b8e · ready
Lane created with the plan. Scope: PLAN-SPAR.yml + the plan-spar/slot tests + validation docs. Evidence
from inv-rules §7(1) / inv-code §3 / inv-tests §3(C). Flagged protected-gate + the secret-is-owner-config
split. No VTID yet.
