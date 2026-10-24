---
lane: onboarding
state: ready
next_actor: kiro
depends_on: [auth-portals]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/onboarding/welcome.tsx
  - apps/mobile/src/screens/onboarding/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/parity/ledger.json
  - apps/mobile/tests/onboarding/**
  - apps/mobile/maestro/onboarding/**
  - src/i18n/*/onboardingNative.json
  - docs/validation/**
updated: 2026-10-21T18:06Z
---
# Onboarding welcome port — `/onboarding/welcome` (post-sign-up Vitana-speech + name/handle form, AuthGuard)
Plan: `.kiro/specs/native-wave2-public-auth-onboarding/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: onboarding -->` (tasks 1–6) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here. **depends_on `auth-portals`:** this lane is the sign-in redirect target
(`src/auth/sign-in.ts: postSignInTarget → /onboarding/welcome`) and shares the auth session / `usePostSignIn` seam —
start only after `auth-portals` is `done`.
**Measured on the worktree (= origin/main):** 1 ledger row under `"lane": "public-auth"` for this lane,
`not_started` — `/onboarding/welcome` (AuthGuard). Web source `src/pages/onboarding/OnboardingWelcome.tsx` (224,
route `src/App.tsx:837`). Reuses the authenticated session from `apps/mobile/src/auth/AuthProvider.tsx` /
`usePostSignIn`.
**Goal.** Port the post-sign-up onboarding welcome to native on the N3 shell under the `(app)` group (AuthGuard) at
1:1 mobile-web parity: the Vitana-speech intro + the name/handle form, consuming the authenticated session; the
sign-in redirect from `auth-portals` lands here. No new auth write (the account already exists). Flips the 1 parity
row to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for `/onboarding/welcome`; mobile-web parity; `@vitana/core`-only web bridge plus the reused
  native `AuthProvider`/`usePostSignIn`; no new auth write.
- `npm run typecheck`, `npm test` (welcome render; name/handle form validation; the AuthGuard — unauthenticated →
  redirect; the sign-in → `/onboarding/welcome` redirect seam resolves), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with the row `native` and its route present in
  `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 5)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 1 row),
`apps/mobile/src/navigation/resolve.ts` (by-entry), and the DE-first i18n shard (only this lane's keys) are shared by
row/line with the other two lanes; resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no new auth write, no test against production; staging specs are read-only; the native app has no
production profile.
## Log
### 2026-10-21T18:06Z · kiro-planner · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 1 row and the paths were computed from the parity
ledger and `src/App.tsx` so no file belongs to two lanes; `depends_on: [auth-portals]` because this is the sign-in
redirect target and shares the auth session seam. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat
`exafyltd` claims the lane (`queue.mjs claim native-wave2-public-auth-onboarding/onboarding --session <id>`) after
`auth-portals` is `done`. Reviewer seat `hotmail`.
