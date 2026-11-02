---
lane: gateway-scope-lint-contract
state: ready
next_actor: kiro
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: [generated-inventories]
paths:
  - scripts/mt/gateway-scope-lint.mjs
  - scripts/mt/gateway-scope-lint.test.mjs
  - services/gateway/test/mt-route-inventory.test.ts
  - services/gateway/test/mt-contract-canary.test.ts
  - services/gateway/test/mt/**
updated: 2026-11-01T17:06Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05444
---
# Gateway tenant-scope lint + contract/route tests — mt-guardrails-r2/gateway-scope-lint-contract (repo vitana-platform)

Plan: `.kiro/specs/mt-guardrails-r2/plan.md` (authoritative) and the `gateway-scope-lint-contract` section
of `tasks.md` (L1–L3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

VTIDs come from PLAN-SPAR on convergence; never by hand. Depends on
`generated-inventories` (reads the generated route/edge inventory).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no live-system writes. The lint and contract
tests run over fixtures / the local stack only; the contract test must never hit a live tenant. Keep
`npm run test:support` (42c), `npm run test:operator` (42e), `npm run test:roles` (42h) green. Work only
inside the allowed paths; add this lane's own `docs/validation/<vtid>/`.

Branch `kiro/mt-guardrails-r2/gateway-scope-lint-contract`; PR title `VTID-xxxxx
(mt-guardrails-r2/gateway-scope-lint-contract): …`; commit trailers `Collab-Session: <your kiro session
id>` and `Collab-Lane: mt-guardrails-r2/gateway-scope-lint-contract`. When the PR is open: set
`state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011402-f523 · ready
Lane created with the re-plan `mt-guardrails-r2` (carried from `mt-guardrails`).

### 2026-11-01T17:06Z · ci-plan-spar · ready (VTID allocated)
VTID-05444 allocated after policy approval (converged-auto-v1).
