---
lane: env-profiles
state: done
next_actor: kiro
depends_on: [vitana-v1-verified]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
pr: https://github.com/exafyltd/vitana-v1/pull/1466
paths:
  - apps/mobile/src/config/env.ts
  - apps/mobile/env/**
  - apps/mobile/tests/env.test.ts
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-10-20T08:41Z
vtid: VTID-05249
---
# Per-profile env source for native builds (decision 1)
Plan: `.kiro/specs/native-g1-wiring/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: env-profiles -->` (tasks E1–E4) are authoritative. VTID: assigned by CI after PLAN-SPAR
converges; do not start before `vtid:` is set here.
**Goal.** Resolve each build profile's endpoints from a committed, non-secret, non-production source
(`apps/mobile/env/development.json` empty; `test-g1.example.json` G1 placeholders only), fed into the
existing `loadConfig` without weakening `assertNotProduction` / `assertNotProductionKey` /
`ConfigMissingError` (`apps/mobile/src/config/env.ts:82`,`:105`,`:189`). No new key, no default URL.
**Acceptance (the reviewer seat checks these):**
- `development` resolves to `{}` (no network); `test-g1` placeholder set loads and every URL passes
  `assertNotProduction`; a production/staging host or the production publishable key in a profile throws;
  a missing required `test-g1` value yields `ConfigMissingError` naming the keys.
- `cd apps/mobile && npm test`, `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=test-g1 npm run bundle` all green offline.
- NATIVE-CI and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only shell nav), `plan-sparring.md`.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no
writes to Supabase/AWS, no test against production; never point a build at a real/production/staging host.
## Log
### 2026-10-17T10:56Z · <kiro-session-id> · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). Paths computed so no file is shared with
another lane. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-g1-wiring/env-profiles --session <id>`).

### 2026-10-20T08:41Z · ci-plan-spar · ready (VTID allocated)
VTID-05249 allocated after policy approval (converged-auto-v1).

### 2026-10-20T10:30Z · kiro-202610151913-51bd · (lane-status) → done
Code merged to vitana-v1 main: PR #1466 (50873056a). Per-profile env source implemented, reviewed
(APPROVED, all four acceptance cases proven, guards byte-identical to origin/main), both profiles bundle
offline. Marked done.
