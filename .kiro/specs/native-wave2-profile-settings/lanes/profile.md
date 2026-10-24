---
lane: profile
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/me/profile.tsx
  - apps/mobile/app/(app)/u/[identifier].tsx
  - apps/mobile/app/(app)/profile/me/privacy.tsx
  - apps/mobile/app/(app)/profile/[id].tsx
  - apps/mobile/src/screens/profile/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/profile/**
  - apps/mobile/maestro/profile/**
  - apps/mobile/parity/ledger.json
  - src/i18n/*/profileNative.json
  - docs/validation/**
updated: 2026-10-21T17:59Z
---
# Profile port — `/me/profile` (view + edit), `/u/:identifier` (+ `?match_intent=`), `/profile/me/privacy`, `/profile/:id`
Plan: `.kiro/specs/native-wave2-profile-settings/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: profile -->` (tasks 1–7) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here. depends_on: none — runs in parallel with `settings` and `support-connectors`.
**Measured on the worktree (= origin/main):** 5 ledger rows under `"lane": "profile-settings-support"` for this
lane, all `not_started` — `PROFILE.ME /me/profile`, `PROFILE.PUBLIC /u/:identifier`,
`PROFILE.WITH_MATCH /u/:identifier?match_intent=:intent_id` (both shape `/u/:`), `PROFILE.PRIVACY /profile/me/privacy`,
and the exclusion route `/profile/:id` → 4 native route files. Web sources `src/pages/EditProfilePage.tsx`
(739 lines; route `src/App.tsx:1483-1487`, `/me/profile` IS EditProfilePage — view + inline edit drawers),
`src/pages/PublicProfilePage.tsx` (413 lines; route `src/App.tsx:1493`), `src/pages/PrivacySettings.tsx` (301 lines;
route `src/App.tsx:1501-1505`), `LegacyProfileRedirect` (`src/App.tsx:1482`). Data hooks (`useProfileGallery`,
`useProfileMilestones`, `useProfileShare`, …) are class-B and re-implemented natively (plan decision 2 — no core
extraction).
**Goal.** Port the member's own profile (view + inline edit drawers), the public profile (+ the `?match_intent=`
highlight) and the privacy/visibility screen to native on the N3 shell at 1:1 mobile-web parity, plus the legacy
`/profile/:id` redirect. All edits (avatar/cover/gallery upload, about/identity/visibility drawers, privacy toggles)
are writes — the ports are wired and the unit tests assert the built request against a MOCKED gateway and fire
nothing (plan decision 5). Flips the 5 parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the profile surfaces; mobile-web parity; `@vitana/core`-only web bridge; data hooks
  re-implemented natively (no core extraction).
- `npm run typecheck`, `npm test` (my-profile loaded/empty/error; a section drawer opens and its save builds the
  right request against a mocked gateway and fires nothing; public profile loaded/not-found + `?match_intent=`
  highlight; privacy toggles build the right request mocked; legacy `/profile/:id` resolves and navigates),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with the 5 rows `native` and their base-shape routes present
  in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 6)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`, and at G1 it runs only on the isolated test environment (write-heavy cluster — never
  a live backend as the test account).
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 5 rows), `apps/mobile/src/ports/**` +
`apps/mobile/src/navigation/resolve.ts` (shared native infra — this lane adds only the profile resolver aliases it
needs), and the DE-first i18n shard `src/i18n/*/profileNative.json` are shared by row/line; resolve a merge conflict
by keeping both lanes' rows/keys. This lane does **not** touch `packages/core/**` (no extraction).
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-21T17:59Z · kiro-202610211759-c58e · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 5 rows (→ 4 route files) and the paths were
computed from the parity ledger and `src/App.tsx` so no file belongs to two lanes; no `depends_on`. Next: PLAN-SPAR
spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-profile-settings/profile --session <id>`). Reviewer seat `hotmail`.
