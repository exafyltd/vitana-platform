---
lane: client-identity-gateway
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: backend
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/client-identity/**
  - services/gateway/test/client-identity*
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T12:07Z
vtid: VTID-05657
---
# Gateway classification of native, Appilix and web requests (adoption measurement, gateway side)
Plan: `.kiro/specs/native-wave3-release-r2/` — `plan.md` (decision 2) and the `tasks.md` section marked
`<!-- lane: client-identity-gateway -->` (tasks G1–G3) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** Add the pure request classifier `classifyClient(headerValue): 'native' | 'web'` (tasks G1-G2): a well-formed
`X-Vitana-Client: native/...` is `native`; a missing or malformed header is `web`. No I/O, no Express import. The middleware,
the daily-seen storage and the adoption query (including the per-member `appilix` derivation) are in lane
`client-identity-store`.

**Acceptance (reviewer agent):** Jest tests cover native iOS and Android, a missing header, a malformed header, an unknown
platform and an unknown version. The function is pure; no staging probe for this lane alone (the probe is in
`client-identity-store`). Governance checks green.

**Never:** no write to user data, no call to the production gateway or database from a session tool, no alteration of
the existing `AI-27` routing rule, no VTID by hand.

## Log
### 2026-11-08T12:30Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave3-release/client-identity-gateway`, PR #4770).

### 2026-11-08T12:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05657 allocated after policy approval (converged-auto-v1).
