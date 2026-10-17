---
lane: local-test-stack
state: ready
next_actor: owner
executor: kiro
seat: hotmail
reviewer_seat: exafy
depends_on: []
paths:
  - supabase/tests/fixtures/**
  - supabase/tests/local-stack/**
  - scripts/mt/stack/**
  - docs/multitenancy/LOCAL-STACK.md
updated: 2026-10-16T21:44Z
---
# D11 local Supabase stack + fixtures — mt-guardrails/local-test-stack (repo vitana-platform)

Plan: `.kiro/specs/mt-guardrails/plan.md` (authoritative) and the `local-test-stack` section of
`tasks.md` (T1–T4, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

`next_actor: owner` is a HELD state: it flips to `kiro` automatically when PLAN-SPAR allocates this
lane's VTID after the plan converges. Do not start before then.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no Supabase or AWS writes against any live
system. The schema snapshot comes from a `--schema-only` dump (structure only, never data); fixtures are
synthetic (D11/D13). Work only inside the allowed paths. Add this lane's own
`docs/validation/<vtid>/` (plan copy, `scope.json`, `staging-tests.json`).

Branch `kiro/mt-guardrails/local-test-stack`; PR title `VTID-xxxxx (mt-guardrails/local-test-stack): …`;
commit trailers `Collab-Session: <your kiro session id>` and `Collab-Lane:
mt-guardrails/local-test-stack`. When the PR is open: set `state: in-review`, `next_actor: kiro`,
`pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-16T21:44Z · kiro-hotmail-202610151618-b437 · created → ready
Created from the WS0 plan. First lane of the chain: `generated-inventories` and `pgtap-isolation-suite`
depend on the stack + fixtures this lane commits. Held at `next_actor: owner` until PLAN-SPAR allocates
the VTID.
