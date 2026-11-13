---
lane: bootstrap-pack-rules
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/operator-bootstrap-pack.ts
  - services/gateway/test/vtid-05792-bootstrap-pack-rules.test.ts
  - docs/validation/VTID-05792/**
updated: 2026-11-13T11:20Z
---
# Operator bootstrap pack — rules start at CLAUDE.md PART 1 (VTID-05792)
Plan: `.kiro/specs/ci-gate-invariants/` — `plan.md` (Decisions 2–6) and the `tasks.md` section marked
`<!-- lane: bootstrap-pack-rules -->` (tasks B1–B4) are authoritative. Source change: PR #5070, whose commit
`43ace0d89552a37100dd264ef0b5531708f6b23a` carries no Collab trailers, so the lane is built again on its own branch.
VTID: VTID-05792 (owner-named). CI writes the `vtid:` key on convergence.

**Goal.** `extractClaudeMdPart1` starts the operator's rules at CLAUDE.md `# PART 1`, not at the file start, so the
preamble (the Autonomy Contract) is no longer in the pack. Budget and the `# PART 2` cut stay the same.

**Acceptance (reviewer: hotmail):** the new test fails on `origin/main` and passes on the lane head; the existing
`vtid-04018-operator-bootstrap-pack.test.ts` passes unchanged; `docs/validation/VTID-05792/evidence.md` quotes the Jest
output and the flag state. The Autonomy Contract removal is in the PR body, not hidden.

**Never:** no edit to an existing test, no VTID allocation by hand, no flag change, no production or staging write.

## Log
### 2026-11-13T11:20Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (bundle of #5070 after #5050 and #5068 were checked against `main`).
