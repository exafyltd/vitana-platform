---
lane: fixture-gateway
state: in-review
next_actor: kiro
claimed_by: kiro-202610151913-51bd
branch: kiro/native-g1-wiring/fixture-gateway
pr: https://github.com/exafyltd/vitana-v1/pull/1465
depends_on: [vitana-v1-verified]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/tools/fixture-gateway/**
  - apps/mobile/tests/fixture-gateway/**
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-10-20T09:37Z
vtid: VTID-05250
---
# Local fixture gateway for the shell/push/deep-link HTTP contract (decision 3)
Plan: `.kiro/specs/native-g1-wiring/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: fixture-gateway -->` (tasks F1–F3) are authoritative. VTID: assigned by CI after PLAN-SPAR
converges; do not start before `vtid:` is set here.
**Goal.** A new `apps/mobile/tools/fixture-gateway/` (plain CommonJS, loopback bind / private-LAN with an
explicit flag, listen-only — mirror `tools/orb-fake-gateway/server.js:17`) that answers
`GET /api/v1/app-config` (body accepted by `parseAppConfigResponse`, `remote-config.ts:120`, flags +
min-version togglable), `GET /api/v1/auth/me` (signed-in member, 401 togglable),
`POST /api/v1/notifications/token` (records token + `device_type`), and the AASA / `assetlinks.json`
documents for the `.dev` identifiers (`app.config.ts:IDENTIFIERS`). Separate from the ORB fake, which only
speaks the ORB WS/SSE voice protocol.
**Acceptance (the reviewer seat checks these):**
- Each route answers the expected shape; the `app-config` body passes `parseAppConfigResponse`; the
  `auth/me` 401 scenario works; the server binds only to loopback/private and refuses any other address.
- No app-code change (this lane owns only `tools/` + its tests); no import of web `src/` or the web
  Supabase/gateway clients.
- `cd apps/mobile && npm test` (fixture suite), `npm run typecheck` green; NATIVE-CI and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only), `plan-sparring.md`.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no
writes to Supabase/AWS, no test against production; the fixture is local-only and never proxies out.
## Log
### 2026-10-17T10:56Z · <kiro-session-id> · created → ready
Lane drafted with the plan. Independent of `env-profiles` for its own code; the smoke lane depends on both.
Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-g1-wiring/fixture-gateway --session <id>`).

### 2026-10-20T08:41Z · ci-plan-spar · ready (VTID allocated)
VTID-05250 allocated after policy approval (converged-auto-v1).

### 2026-10-20T09:37Z · kiro-202610151913-51bd · ready → in-review
Built the fixture gateway lane and opened its PR. `apps/mobile/tools/fixture-gateway/`
(plain CommonJS, loopback-only / private-LAN behind an explicit flag, listen-only, never
proxies out) answers `GET /api/v1/app-config` (body passes the real `parseAppConfigResponse`,
flags + min-version togglable), `GET /api/v1/auth/me` (signed-in fixture member, 401 togglable),
`POST /api/v1/notifications/token` (records token + `device_type`, 400 on bad input) and the
`.dev` AASA / `assetlinks.json` well-known documents; unknown routes 404. No app-code change —
owns only `tools/` + its tests, imports no web `src/` or Supabase/gateway client.
Checks: fixture jest suite green (15/15), `npm run typecheck` (`tsc --noEmit`) green, loopback-only
bind proven by the suite (`isAllowedBindHost` + `createFixtureGateway` refusing `0.0.0.0`/public),
lane scope clean. Validation artifacts added under `docs/validation/VTID-05250/`
(`scope.json`, read-only `staging-tests.json`, verbatim `plan-sparring.md`).
PR: https://github.com/exafyltd/vitana-v1/pull/1465 · branch `kiro/native-g1-wiring/fixture-gateway`.
Next: reviewer seat `hotmail` checks the acceptance criteria.
