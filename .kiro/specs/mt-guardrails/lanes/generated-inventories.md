---
lane: generated-inventories
state: ready
next_actor: owner
executor: kiro
seat: hotmail
reviewer_seat: exafy
depends_on: [local-test-stack]
paths:
  - scripts/mt/inventory/**
  - scripts/mt/lint/**
updated: 2026-10-18T16:20Z
---
# Generated inventories + DB lint — mt-guardrails/generated-inventories (repo vitana-platform)
Plan: `.kiro/specs/mt-guardrails/plan.md` (authoritative) and the `generated-inventories` section of
`tasks.md` (G1—G5, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
`next_actor: owner` is HELD: it flips to `kiro` when PLAN-SPAR allocates this lane's VTID. Depends on
`local-test-stack` being `done` (the generators read its local stack).
Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no live-system writes. Inventories are
generated from the local schema, never hand-listed; the bare-policy count is reported, never asserted 0
(N3 is a WS1 gate). The lint allowlist is owner-tagged. Reuse the output-format conventions of
`scripts/ci/aurora-migration-inventory.cjs` (VTID-03494), which already inventories the same
table/RPC/realtime/storage categories — but it reads *source*, not DB schema, so it does NOT satisfy
the WS0 DB-lint need; these generators read the local DB schema (R1-F3). Work only inside the allowed
paths; add this lane's own `docs/validation/<vtid>/`.
Branch `kiro/mt-guardrails/generated-inventories`; PR title `VTID-xxxxx
(mt-guardrails/generated-inventories): —`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-guardrails/generated-inventories`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.
## Log
### 2026-10-16T21:44Z · kiro-hotmail-202610151618-b437 · created → ready
Created from the WS0 plan. Produces the route/edge/table inventories the `gateway-scope-lint-contract`
lane consumes and the bare-policy count WS1's N3 gate reads. Held at `next_actor: owner` until the VTID
is allocated.
### 2026-10-18T16:20Z · kiro-hotmail-202610151618-b437 · spar round-1 (fresh session e7f1e151) → aurora-inventory reference
R1-F3 (accepted): the lane now points implementers to `scripts/ci/aurora-migration-inventory.cjs`
(VTID-03494) as a reference for output format and the table/RPC/realtime/storage inventory categories it
already establishes. It reads source, not DB schema, so it does not meet the DB-lint need, but reusing
its conventions avoids reinvention. Also carries the shared health-table-list constant (G4) consumed by
the pgTAP isolation suite until mt-identity's `isHealthTable()` ships.
