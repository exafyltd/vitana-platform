---
lane: pgtap-isolation-suite
state: ready
next_actor: owner
executor: kiro
seat: hotmail
reviewer_seat: exafy
depends_on: [local-test-stack]
paths:
  - supabase/tests/mt/**
  - scripts/mt/pgtap/**
updated: 2026-10-16T21:44Z
---
# pgTAP isolation suite — mt-guardrails/pgtap-isolation-suite (repo vitana-platform)

Plan: `.kiro/specs/mt-guardrails/plan.md` (authoritative) and the `pgtap-isolation-suite` section of
`tasks.md` (P1–P3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

`next_actor: owner` is HELD: it flips to `kiro` when PLAN-SPAR allocates this lane's VTID. Depends on
`local-test-stack` (the suite runs against its seeded local stack).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no live-system writes. The suite only ever
touches the local stack — it is read-only against production by construction (rules 31/48). Use the
mt-identity `isHealthTable()` list for the health tables, not a local copy (CROSS-SPEC O1). Work only
inside the allowed paths; add this lane's own `docs/validation/<vtid>/`.

Branch `kiro/mt-guardrails/pgtap-isolation-suite`; PR title `VTID-xxxxx
(mt-guardrails/pgtap-isolation-suite): …`; commit trailers `Collab-Session: <your kiro session id>` and
`Collab-Lane: mt-guardrails/pgtap-isolation-suite`. When the PR is open: set `state: in-review`,
`next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-16T21:44Z · kiro-hotmail-202610151618-b437 · created → ready
Created from the WS0 plan. Asserts b_member reads 0 T_A rows on the 18 tenant tables + the health tables
and that cross-tenant writes fail. Held at `next_actor: owner` until the VTID is allocated.
