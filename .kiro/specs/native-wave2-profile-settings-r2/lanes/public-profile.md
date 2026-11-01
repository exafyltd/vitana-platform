---
lane: public-profile
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(public)/u/[identifier].tsx
  - apps/mobile/app/(public)/profile/[id].tsx
  - apps/mobile/src/screens/public-profile/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/public-profile/**
  - apps/mobile/maestro/public-profile/**
  - apps/mobile/parity/ledger.json
  - src/i18n/*/publicProfileNative.json
  - docs/validation/**
updated: 2026-11-01T03:04Z
vtid: VTID-05430
---
# Public profile + legacy redirect port — `/u/:identifier` and `/profile/:id` in the `(public)` group
Plan: `.kiro/specs/native-wave2-profile-settings-r2/` — `plan.md` (plan block, decision 1b) and the `tasks.md` section
marked `<!-- lane: public-profile -->` (tasks 1–7) are authoritative. VTID: assigned by CI after PLAN-SPAR converges;
do not start before `vtid:` is set here.
**Measured against `exafyltd/vitana-v1` `origin/main`:** 3 ledger rows under `"lane": "profile-settings-support"`
for this lane, all `not_started` — `PROFILE.PUBLIC /u/:identifier`, `PROFILE.WITH_MATCH
/u/:identifier?match_intent=:intent_id` and the legacy exclusion `/profile/:id`. Web sources
`src/pages/PublicProfilePage.tsx` (413 lines; route `src/App.tsx:1493`, no `AuthGuard`, in `AppLayout`) and
`LegacyProfileRedirect` (`src/App.tsx:1482`, no `AuthGuard`). Neither path is in `GUEST_PATHS`, so the twins live in
`(public)`, outside the `(app)` `AuthGate`.
**Goal.** Port the public profile (read-only, incl. the `?match_intent=` highlight) and the legacy redirect at 1:1
mobile-web parity, reachable signed out as on web. The screen wraps itself in `MobileAppShell` with a session and in
`PublicShell` without one.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R7 for these routes; mobile-web parity; `@vitana/core`-only web bridge; renders signed out and
  signed in with the right shell; both route files are in `(public)`, not `(app)`.
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with the 3 rows `native` and their routes present.
- 11 locales, new keys DE-first (du-form; pt você-form) then mirrored; RTL (`ar`) covered; no hardcoded
  user-visible text; no physical `left`/`right`.
- NATIVE-CI, PR-GATE **Collab handoff** + **Lane scope** green; `docs/validation/<VTID>/` has `scope.json`,
  `staging-tests.json` and `plan-sparring.md`. Device-runtime parity (task 6) is deferred to G1, `next_actor: owner`.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only.
## Log
### 2026-11-01T02:14Z · kiro-exafyltd-202611010001-7819 · ready
Lane created with the plan (r2 sparring R2-F1: `/u/:identifier` and `/profile/:id` moved out of `profile` into
their own lane, in the `(public)` group).

### 2026-11-01T03:04Z · ci-plan-spar · ready (VTID allocated)
VTID-05430 allocated after policy approval (converged-auto-v1).
