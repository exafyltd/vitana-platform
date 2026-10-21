---
lane: settings
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/settings/index.tsx
  - apps/mobile/app/(app)/settings/preferences.tsx
  - apps/mobile/app/(app)/settings/limitations.tsx
  - apps/mobile/app/(app)/settings/tenant-role.tsx
  - apps/mobile/app/(app)/delete-account.tsx
  - apps/mobile/src/screens/settings/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/settings/**
  - apps/mobile/maestro/settings/**
  - apps/mobile/parity/ledger.json
  - src/i18n/*/settingsNative.json
  - docs/validation/**
updated: 2026-10-21T17:59Z
---
# Settings port — the `MobileSettings` `?mode=` hub + `/settings/preferences`, `/settings/limitations`, `/settings/tenant-role`, `/delete-account`
Plan: `.kiro/specs/native-wave2-profile-settings/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: settings -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start
before `vtid:` is set here. depends_on: none — runs in parallel with `profile` and `support-connectors`.
**Measured on the worktree (= origin/main):** 18 ledger rows under `"lane": "profile-settings-support"` for this
lane, all `not_started` → 5 native route files. The 14 `/settings` rows (all shape `/settings`, one file —
`SETTINGS.OVERVIEW` plus 13 `?mode=` variants):
`SETTINGS.OVERVIEW /settings`, `SETTINGS.NOTIFICATIONS`, `SETTINGS.PRIVACY` (+`.visibility`, `.data`, `.security`),
`SETTINGS.PREFERENCES` (+`.appearance`, `.language`), `SETTINGS.BILLING` (+`.plan`, `.payment`, `.invoices`,
`.creator`) — `SETTINGS.OVERVIEW` is the bare `/settings` and the other 13 are `?mode=` sections of the one
`MobileSettings` screen (`VALID_SECTIONS`
`src/pages/MobileSettings.tsx:39-44`). Plus 3 standalone + 1 exclusion:
`SETTINGS.PREFERENCES_ACCESSIBILITY /settings/preferences?section=accessibility` (shape `/settings/preferences`; note
`accessibility` is NOT in `VALID_SECTIONS` — reproduce the current web fallback, requirements R1.5),
`SETTINGS.LIMITATIONS /settings/limitations` (web `src/pages/settings/Limitations.tsx`, 491 lines; route
`src/App.tsx:1436-1440`), `SETTINGS.TENANT_ROLE /settings/tenant-role` (web `src/pages/settings/TenantRole.tsx`,
388 lines; route `src/App.tsx:1454-1460`), `/delete-account` (web `src/pages/legal/DeleteAccount.tsx`; route
`src/App.tsx:847`). Web source `src/pages/MobileSettings.tsx` (603 lines; router `src/App.tsx:689-692`, sections
`:1414-1467`). Settings data hooks (`useNotificationPreferences`, `useNotificationCategoryPreferences`, …) are
class-B and re-implemented natively (plan decision 2 — no core extraction).
**Goal.** Port the unified mobile settings screen (one file reading `?mode=`, rendering the same section `switch` as
the web for notifications / privacy[.*] / preferences[.*] / billing[.*]) and its three standalone sub-screens plus
the account-deletion flow to native on the N3 shell at 1:1 mobile-web parity. Every toggle/action/delete is a write
— ports wired, unit tests assert the built request against a MOCKED gateway and fire nothing (plan decision 5).
Flips all 18 rows to `native`.
**Disjointness note.** This lane declares the specific files it creates under `apps/mobile/app/(app)/settings/`
(`index.tsx`, `preferences.tsx`, `limitations.tsx`, `tenant-role.tsx`) — NOT a bare `settings/**` — so it never
claims `settings/connected-apps.tsx`, which belongs to `support-connectors` (design §1a). No file in two lanes.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the settings surfaces; mobile-web parity; `@vitana/core`-only web bridge; data hooks
  re-implemented natively (no core extraction); the `accessibility` param reproduces the web fallback (R1.5).
- `npm run typecheck`, `npm test` (each `?mode=` section renders — 13 modes; a toggle/action per section builds the
  right request against a mocked gateway and fires nothing; preferences `?section=` fallback; limitations +
  tenant-role loaded/empty/error; delete-account confirm builds the delete request mocked),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/parity-ledger.mjs --check` green with the 18 rows `native` (query variants satisfied by the
  `/settings` base-shape file) and the routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 7)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`, and at G1 it runs only on the isolated test environment (write-heavy cluster — never
  a live backend as the test account).
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 18 rows), `apps/mobile/src/ports/**` +
`apps/mobile/src/navigation/resolve.ts` (shared native infra — only this lane's settings resolver aliases), and the
DE-first i18n shard `src/i18n/*/settingsNative.json` are shared by row/line; resolve a merge conflict by keeping both
lanes' rows/keys. This lane does **not** touch `packages/core/**` (no extraction).
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-21T17:59Z · kiro-202610211759-c58e · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 18 rows (→ 5 route files; 14 of them share the
one `/settings` file — `SETTINGS.OVERVIEW` + 13 `?mode=` variants, `shapeOf` drops the query) and the paths were
computed from the parity ledger,
`MobileSettings.tsx` `VALID_SECTIONS` and `src/App.tsx` so no file belongs to two lanes; the shared `settings/`
directory is split from `support-connectors` by explicit file names (design §1a); no `depends_on`. Next: PLAN-SPAR
spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-profile-settings/settings --session <id>`). Reviewer seat `hotmail`.
