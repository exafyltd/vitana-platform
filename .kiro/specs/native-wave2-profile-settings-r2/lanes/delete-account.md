---
lane: delete-account
state: done
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
updated: 2026-11-03T16:12Z
vtid: VTID-05428
claimed_by: kiro-exafyltd-202611011658-9f52
branch: kiro/native-wave2-profile-settings-r2/delete-account
pr: https://github.com/exafyltd/vitana-v1/pull/1547
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

### 2026-11-01T03:04Z · ci-plan-spar · ready (VTID allocated)
VTID-05428 allocated after policy approval (converged-auto-v1).
### 2026-11-01T17:08Z · kiro-exafyltd-202611011658-9f52 · ready → executing
Claimed by kiro-exafyltd-202611011658-9f52 (Kiro Web driver, seat exafyltd); built by a delegated builder under this session on vitana-v1 branch `kiro/native-wave2-profile-settings-r2/delete-account`.
### 2026-11-01T18:04Z · kiro-exafyltd-202611011658-9f52 · executing → in-review
PR https://github.com/exafyltd/vitana-v1/pull/1547. Evidence: vitana-v1 `docs/validation/VTID-05428/` (commands.log, red-on-base, verification.md, staging-tests.json).

### 2026-11-02T09:31:00Z · agent-vitana-lane-reviewer-202611020931-16c8 · review
review: accept
head: 2c529e7780880660fc44500b32cde3d5b42ff176
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-v1/pull/1547
Findings: non-blocking: Maestro/device parity and real OAuth deferred to G1 (task 5, next_actor owner). Re-review after merging main (memory ec8682f, diary 514e06a, #1552) into the accepted head 6fb15909: the lane diff vs origin/main is unchanged (26 files, +1110/-1, all within lane paths). Its three-dot diff differs from the accepted head's only in context lines of the resolve.ts hunk. In resolve.ts, '/delete-account' sits between '/comm/open-asks' and '/daily-diary'. The file has no duplicate route lines and no conflict markers, and keeps every main route (main has 31 route lines, the head has 32, the extra one being '/delete-account'). The '/daily-diary' and '/memory*' routes from main are kept. The delete-account test file and i18n files are byte-identical to the accepted head. All 20 check runs on the head are complete: 15 success, 5 skipped (fanout, collect, pivot, extraction dependency analysis, plus one more skipped job). Lane scope, pr-gate, the parity ledger/generators job (the stale gen-core-extract red from the accepted head is now green after main's fix), apps/mobile typecheck/test/bundle, ESLint native, i18n, Vitest and preview-e2e are all green. The PR's mergeable state is clean.
Next: the land step merges under §7b
Stored by the landing session kiro-exafyltd-202611011658-9f52 on the agent's behalf (lane-land.md step 2).
### 2026-11-03T16:12Z · kiro-exafyltd-202611011658-9f52 · in-review → verified
Accepted by agent:vitana-lane-reviewer on head `2c529e7780880660fc44500b32cde3d5b42ff176` (review entry above); every required check green, up to date with main.
### 2026-11-03T16:12Z · kiro-exafyltd-202611011658-9f52 · verified → done
merge: 6bea4890812195ab56284c411b9c8b8c4ce21a97 · authority: §7b PM rule (applied by the plan driver while the PM is not live), squash. Staging: AWS Stage Deploy Community App rolled 6bea489 (https://github.com/exafyltd/vitana-v1/actions/runs/41421479628). STAGING-VERIFY https://github.com/exafyltd/vitana-platform/actions/runs/41433483490 failed 70/74, all four reds web colour specs (raw palette class lucide-shield text-slate-400 on /comm, /discover, /settings, /memory/diary; web app chrome outside this lane, fixed on main by e530abd #1556). Re-dispatches https://github.com/exafyltd/vitana-platform/actions/runs/41442050124 (cancelled after 75 min) and https://github.com/exafyltd/vitana-platform/actions/runs/41671439422 (superseded in the community-app concurrency queue) did not complete; STAGING-VERIFY on this SHA is pending. The later run on b74d3ba, which contains 6bea489, passed: https://github.com/exafyltd/vitana-platform/actions/runs/41525408839.
