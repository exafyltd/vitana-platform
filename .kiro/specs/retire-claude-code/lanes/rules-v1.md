---
lane: rules-v1
state: ready
next_actor: kiro
depends_on: [scope-rules, rules-platform]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: jtadic
governance: true
paths:
  - .claude/rules/collaboration.md
  - CLAUDE.md
  - .kiro/steering/vitana-load-project-rules.md
  - .kiro/steering/vitana-kiro-notes.md
  - .kiro/steering/vitana-standing-rules.md
  - .kiro/steering/vitana-collaboration.md
  - docs/validation/VTID-*/**
updated: 2026-10-20T10:51Z
vtid: VTID-05258
---
# Rule text without Claude Code (vitana-v1 — PR in exafyltd/vitana-v1)
Plan: `.kiro/specs/retire-claude-code/` — `plan.md` and the `tasks.md` section `<!-- lane: rules-v1 -->` are
authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
**Governance lane:** merge only on the owner's explicit per-PR instruction and an approving review from seat `jtadic` on the current head; never from an automation run.

## Log
### 2026-10-20T10:45Z · kiro-exafyltd-202610201041-ab5d · created → ready
Lane drafted with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafyltd claims it.

### 2026-10-20T10:51Z · ci-plan-spar · ready (VTID allocated)
VTID-05258 allocated after policy approval (converged-auto-v1).
