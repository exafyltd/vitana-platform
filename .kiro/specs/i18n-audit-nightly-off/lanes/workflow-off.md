---
lane: workflow-off
state: executing
next_actor: kiro
depends_on: []
executor: claude
reviewer_seat: exafy
paths:
  - .github/workflows/i18n-audit-llm.yml
  - CLAUDE.md
  - scripts/i18n-audit-llm.mjs
  - docs/validation/**
claimed_by: kiro-202610181950-f0b7
branch: kiro/i18n-audit-nightly-off/workflow-off
pr: https://github.com/exafyltd/vitana-v1/pull/1470
updated: 2026-10-21T11:30Z
vtid: VTID-05284
---
# Lane: workflow-off
Repo: **vitana-v1** (`paths` are vitana-v1 paths). Draft PR: https://github.com/exafyltd/vitana-v1/pull/1463.
Tasks T1–T4 in `tasks.md`. Claude Code builds it because `.github/**` and `CLAUDE.md` are governance paths. The
VTID is allocated by PLAN-SPAR on convergence.
## Log
### 2026-10-19T17:40Z · kiro-202610181950-f0b7 · ready
Lane created with the plan.
### 2026-10-21T08:48Z · ci-plan-spar · ready (VTID allocated)
VTID-05284 allocated after policy approval (converged-auto-v1).
### 2026-10-21T11:30Z · kiro-202610181950-f0b7 · executing
Claimed (`collab-claim/i18n-audit-nightly-off/workflow-off`). Built by the Kiro exceptions seat because Claude Code is
unavailable (`CLAUDE_AVAILABLE=false`). Lane PR: exafyltd/vitana-v1#1470 (T1–T4: nightly schedule and
`audit-nightly` job removed, `pull-requests: write` dropped, provider default `deepseek` in the workflow and the
script, `CLAUDE.md` audit command updated; evidence in `docs/validation/VTID-05284/`, red on base 8 fails, green on
head 10/10). `paths` gains `scripts/i18n-audit-llm.mjs`: the converged plan (change 4) and `tasks.md` T4 change it,
but the lane was created without it, so Lane scope on #1470 refused it. No behaviour beyond the plan.
