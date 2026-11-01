---
lane: generated-inventories
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: [local-test-stack]
paths:
  - scripts/mt/inventory/**
  - scripts/mt/lint/**
updated: 2026-11-01T15:30Z
repos: [exafyltd/vitana-platform]
---
# Generated inventories + DB lint — mt-guardrails-r2/generated-inventories (repo vitana-platform)
Plan: `.kiro/specs/mt-guardrails-r2/plan.md` (authoritative) and the `generated-inventories` section of
`tasks.md` (G1—G5, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
VTIDs come from PLAN-SPAR on convergence; never by hand. Depends on
`local-test-stack` being `done` (the generators read its local stack).
Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no live-system writes. Inventories are
generated from the local schema, never hand-listed; the bare-policy count is reported, never asserted 0
(N3 is a WS1 gate). The lint allowlist is owner-tagged. Reuse the output-format conventions of
`scripts/ci/aurora-migration-inventory.cjs` (VTID-03494), which already inventories the same
table/RPC/realtime/storage categories — but it reads *source*, not DB schema, so it does NOT satisfy
the WS0 DB-lint need; these generators read the local DB schema (R1-F3). Work only inside the allowed
paths; add this lane's own `docs/validation/<vtid>/`.
Branch `kiro/mt-guardrails-r2/generated-inventories`; PR title `VTID-xxxxx
(mt-guardrails-r2/generated-inventories): —`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-guardrails-r2/generated-inventories`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011402-f523 · ready
Lane created with the re-plan `mt-guardrails-r2` (carried from `mt-guardrails`).
