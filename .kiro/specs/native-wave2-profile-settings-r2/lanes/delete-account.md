---
lane: delete-account
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(public)/delete-account.tsx
  - apps/mobile/src/screens/delete-account/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/delete-account/**
  - apps/mobile/maestro/delete-account/**
  - apps/mobile/parity/ledger.json
  - src/i18n/*/deleteAccountNative.json
  - docs/validation/**
updated: 2026-11-01T01:17Z
---
# Public delete-account port — `/delete-account` in the `(public)` group
Plan: `.kiro/specs/native-wave2-profile-settings-r2/` — `plan.md` (plan block, decision 1a) and the `tasks.md` section
marked `<!-- lane: delete-account -->` (tasks 1–6) are authoritative. VTID: assigned by CI after PLAN-SPAR converges;
do not start before `vtid:` is set here.
**Measured against `exafyltd/vitana-v1` `origin/main`:** 1 ledger row under `"lane": "profile-settings-support"` for
this lane, the exclusion route `/delete-account` (`not_started`). Web source `src/pages/legal/DeleteAccount.tsx`
(route `src/App.tsx:847`, "Public Routes - No Auth Required", no `AuthGuard`). The native `(app)` group's `AuthGate`
redirects signed-out visitors unless the path is an `allowGuest` route, so the twin lives in `(public)`.
**Goal.** Port the account-deletion page at 1:1 mobile-web parity as `apps/mobile/app/(public)/delete-account.tsx`,
reachable signed out (as on web) and signed in. The destructive delete request is built and asserted against a mocked
gateway, never fired.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R7 and R5.1/R5.2 for `/delete-account`; mobile-web parity; `@vitana/core`-only web bridge; renders
  signed out and signed in; the route file is in `(public)`, not `(app)`.
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with `/delete-account` `native` and its route present.
- 11 locales, new keys DE-first (du-form; pt você-form) then mirrored; RTL (`ar`) covered; no hardcoded
  user-visible text; no physical `left`/`right`.
- NATIVE-CI, PR-GATE **Collab handoff** + **Lane scope** green; `docs/validation/<VTID>/` has `scope.json`,
  `staging-tests.json` and `plan-sparring.md`. Device-runtime parity (task 5) is deferred to G1, `next_actor: owner`.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production, no delete request ever sent; staging specs are read-only.
## Log
### 2026-11-01T01:17Z · kiro-exafyltd-202611010001-7819 · ready
Lane created with the plan (r2 sparring R1-F1: `/delete-account` moved out of `settings` into its own lane, in the
`(public)` group).
