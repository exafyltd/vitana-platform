---
lane: client-identity-app
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/src/config/client-identity.ts
  - apps/mobile/src/config/http.ts
  - apps/mobile/tests/client-identity*
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T12:07Z
vtid: VTID-05656
---
# Native client-identity header on gateway calls (adoption measurement, app side)
Plan: `.kiro/specs/native-wave3-release-r2/` — `plan.md` (decision 2) and the `tasks.md` section marked
`<!-- lane: client-identity-app -->` (tasks C1–C3) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** Send `X-Vitana-Client: native/<platform>/<version>` on every gateway call from `apps/mobile/src/config/http.ts`,
so the gateway (lane `client-identity-gateway`) can count native members against the ≥95 % adoption threshold. No
member-visible change. No new dependency.

**Acceptance (reviewer: hotmail):** `client-identity.ts` builds the header from `Platform.OS` and the app version; the
header is on gateway calls and absent on third-party calls; `npm test` and `npm run typecheck` pass in `apps/mobile`;
the offline bundle passes for `development` and `test-g1`; `docs/validation/<VTID>/scope.json` lists only the paths above.

**Never:** no change to timeouts, retries or the `assertNotProduction` guard; no production host; no VTID by hand.

## Log
### 2026-11-08T12:30Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave3-release/client-identity-app`, PR #4770).

### 2026-11-08T12:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05656 allocated after policy approval (converged-auto-v1).
