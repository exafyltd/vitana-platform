---
lane: client-identity-app
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/src/config/client-identity.ts
  - apps/mobile/src/config/http.ts
  - apps/mobile/tests/client-identity*
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-07T10:33Z
---
# Native client-identity header on gateway calls (adoption measurement, app side)
Plan: `.kiro/specs/native-wave3-release/` — `plan.md` (decision 2) and the `tasks.md` section marked
`<!-- lane: client-identity-app -->` (tasks C1–C3) are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** Send `X-Vitana-Client: native/<platform>/<version>` on every gateway call from `apps/mobile/src/config/http.ts`,
so the gateway (lane `client-identity-gateway`) can count native members against the ≥95 % adoption threshold. No
member-visible change. No new dependency.

**Acceptance (reviewer: hotmail):** `client-identity.ts` builds the header from `Platform.OS` and the app version; the
header is on gateway calls and absent on third-party calls; `npm test` and `npm run typecheck` pass in `apps/mobile`;
the offline bundle passes for `development` and `test-g1`; `docs/validation/<VTID>/scope.json` lists only the paths above.

**Never:** no change to timeouts, retries or the `assertNotProduction` guard; no production host; no VTID by hand.

## Log
### 2026-11-07T10:33Z · kiro-exafyltd-202611062257-540e · created → ready
Drafted with the plan. `src/config/http.ts` is edited only by this lane.
