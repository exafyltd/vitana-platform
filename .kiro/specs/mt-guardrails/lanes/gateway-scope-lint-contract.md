---
lane: gateway-scope-lint-contract
state: ready
next_actor: owner
executor: kiro
seat: jtadic
reviewer_seat: exafyltd
depends_on: [generated-inventories]
paths:
  - scripts/mt/gateway-scope-lint.mjs
  - scripts/mt/gateway-scope-lint.test.mjs
  - services/gateway/test/mt-route-inventory.test.ts
  - services/gateway/test/mt-contract-canary.test.ts
  - services/gateway/test/mt/**
updated: 2026-10-16T21:44Z
---
# Gateway tenant-scope lint + contract/route tests — mt-guardrails/gateway-scope-lint-contract (repo vitana-platform)

Plan: `.kiro/specs/mt-guardrails/plan.md` (authoritative) and the `gateway-scope-lint-contract` section
of `tasks.md` (L1–L3, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

`next_actor: owner` is HELD: it flips to `kiro` when PLAN-SPAR allocates this lane's VTID. Depends on
`generated-inventories` (reads the generated route/edge inventory).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md`, no merge/approve/deploy/workflow dispatch, no live-system writes. The lint and contract
tests run over fixtures / the local stack only; the contract test must never hit a live tenant. Keep
`npm run test:support` (42c), `npm run test:operator` (42e), `npm run test:roles` (42h) green. Work only
inside the allowed paths; add this lane's own `docs/validation/<vtid>/`.

Branch `kiro/mt-guardrails/gateway-scope-lint-contract`; PR title `VTID-xxxxx
(mt-guardrails/gateway-scope-lint-contract): …`; commit trailers `Collab-Session: <your kiro session
id>` and `Collab-Lane: mt-guardrails/gateway-scope-lint-contract`. When the PR is open: set
`state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-16T21:44Z · kiro-hotmail-202610151618-b437 · created → ready
Created from the WS0 plan. Bans header/query tenant outside admin routes (S-I), requires a public-route
allowlist, and proves no `CANARY_A` leaks across role×tenant incl. edge functions. Held at
`next_actor: owner` until the VTID is allocated.
