---
lane: auth-portals
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(public)/maxina.tsx
  - apps/mobile/app/(public)/alkalma.tsx
  - apps/mobile/app/(public)/[tenantSlug].tsx
  - apps/mobile/app/(public)/auth/confirmed.tsx
  - apps/mobile/app/(public)/maxina/confirmed.tsx
  - apps/mobile/app/(public)/alkalma/confirmed.tsx
  - apps/mobile/app/(public)/oauth/complete.tsx
  - apps/mobile/app/(app)/oauth/consent.tsx
  - apps/mobile/app/(public)/reset-password.tsx
  - apps/mobile/app/(public)/logout.tsx
  - apps/mobile/src/screens/auth/**
  - apps/mobile/src/auth/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/parity/ledger.json
  - apps/mobile/tests/auth/**
  - apps/mobile/maestro/auth/**
  - src/i18n/*/authPortalsNative.json
  - docs/validation/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/extract.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
updated: 2026-11-01T18:20Z
vtid: VTID-05449
---
# Portals / OAuth / reset / confirm port — `/maxina`, `/alkalma`, `/:tenantSlug`, confirm ×3, OAuth ×2, reset, logout
Plan: `.kiro/specs/native-wave2-public-auth-onboarding-r3/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: auth-portals -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured on the worktree (= origin/main):** 10 ledger rows under `"lane": "public-auth"` for this lane —
`AUTH.MAXINA_PORTAL /maxina` (`in_progress`), `AUTH.ALKALMA_PORTAL /alkalma` (`in_progress`), `/:tenantSlug`,
`/auth/confirmed`, `/maxina/confirmed`, `/alkalma/confirmed`, `/oauth/complete` (`in_progress`), `/oauth/consent`
(AuthGuard), `/reset-password` (`in_progress`), `/logout` (`in_progress`). Web sources
`src/pages/portals/MaxinaPortal.tsx` (878, route `src/App.tsx:876`), `src/pages/portals/TenantPortal.tsx` (313,
`slug="alkalma"`, routes `:878`/`:2337`), `src/pages/auth/EmailConfirmed.tsx` (112, `:825`),
`src/pages/portals/MaxinaConfirmed.tsx` (146, `:832`), `src/pages/portals/AlkalmaConfirmed.tsx` (123, `:833`),
`src/pages/auth/OAuthComplete.tsx` (250, `:829`), `src/pages/OAuthConsent.tsx` (176, `:1860`),
`src/pages/auth/ResetPassword.tsx` (281, `:844`), `src/pages/Logout.tsx` (89, `:850`). N3 (VTID-05186) already landed
the functional `apps/mobile/src/screens/auth/{PortalScreen,OAuthCompleteScreen,ResetPasswordScreen,LogoutScreen}.tsx`
and `apps/mobile/src/auth/{AuthProvider,sign-in}.ts`; the link plumbing
`apps/mobile/src/linking/{resolve-link,link-router,auth-port}.ts` already tags `/auth/confirmed`+`/reset-password` →
`auth` and `/oauth/complete` → `oauth_return`.
**Goal.** Complete the five `in_progress` N3 functional screens to mobile-web portal chrome (intro video, events
teaser, Orb hint, diag badge per the `PortalScreen` header comment) and add the confirm (×3) + `/oauth/consent`
screens, at 1:1 mobile-web parity on the N3 shell. Reuse the link + auth plumbing (resolve-link / link-router /
auth-port / AuthProvider) and the one auth-write path `src/auth/sign-in.ts` — never re-implement sign-in. Sign-in is
the only allowed auth write (against the fake Supabase double in tests). Flips the 10 parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the portal / OAuth / reset / confirm surfaces; mobile-web parity; `@vitana/core`-only web
  bridge plus the reused native auth/linking trees; sign-in the one auth write, everything else read/fixture.
- `npm run typecheck`, `npm test` (portal tab switch + field validation; sign-in success → `postSignInTarget` is
  `/onboarding/welcome`; reset-request; confirm loaded/expired; OAuth-return; logout; deep-link resolution tags),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with the 10 rows `native` and their routes present in
  `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity + the real OAuth browser round-trip (task 7)** are deferred to G1 as `next_actor: owner`;
  not a merge blocker, recorded in this log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 10 rows),
`apps/mobile/src/navigation/resolve.ts` (by-entry), `apps/mobile/src/auth/**` + `apps/mobile/src/linking/**` (reused;
only this lane may extend `src/auth/sign-in.ts`), and the DE-first i18n shard (only this lane's keys) are shared by
row/line; resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production (sign-in runs only against the fake double); staging specs are read-only; the
native app has no production profile.
## Log
### 2026-11-01T17:25Z · kiro-exafyltd-202611011658-9f52 · ready
Lane created with the plan (re-plan of `native-wave2-public-auth-onboarding-r2/auth-portals`, PR #4545); `paths` widened to the shared native-infra files.

### 2026-11-01T18:20Z · ci-plan-spar · ready (VTID allocated)
VTID-05449 allocated after policy approval (converged-auto-v1).
