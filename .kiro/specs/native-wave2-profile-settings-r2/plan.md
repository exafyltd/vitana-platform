# Plan — native-wave2-profile-settings-r2
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`,
`apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; **no `@vitana/core` change in this
plan** — the cluster's hooks are class-B data hooks, re-implemented natively, never moved into core; no backend, no
gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this folder.
Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2.
<!-- plan:begin -->
## Re-plan
Re-plan of native-wave2-profile-settings (PR #4278, converged) under a new slug; the old branch has commits without Collab trailers.
The content below is the converged plan of `native-wave2-profile-settings` unchanged except the slug. The old plan's VTIDs (VTID-05373, VTID-05374, VTID-05375) were written only on the old PR branch, never on `main`; they are to be retired (terminalized `cancelled` by the PM or the exceptions seat once these lanes have their own VTIDs); this plan does not touch the ledger.
Sparring history: https://github.com/exafyltd/vitana-platform/pull/4278 (rounds under `.kiro/specs/native-wave2-profile-settings/sparring/` on the old branch; not copied here). PLAN-SPAR spars this slug as a fresh session.
## Cross-repo sparring
This plan's implementation lives in `exafyltd/vitana-v1` (native app `apps/mobile/**`, `packages/core/**`, the parity
ledger, i18n shards), while the plan PR itself is in `exafyltd/vitana-platform`. Every load-bearing premise the
sparring partner must verify — the parity-ledger rows for `"lane": "profile-settings-support"`, the `src/App.tsx`
routes, and the profile/settings/support/connectors web source pages and their class-A/class-B module classification —
is therefore a vitana-v1 file. The partner reads those files through the `spar_refs` (`exafyltd/vitana-v1: main`)
declared in `handoff.md`, which PLAN-SPAR forwards as `extra_refs`; findings about the frontend half must cite
vitana-v1 paths read via that ref.
## Goal
Wave 2 screen-port batch of the native Maxina app: port the profile / settings / support / connectors cluster — the
37 web destinations the parity ledger assigns to `"lane": "profile-settings-support"` — to the native app
(`apps/mobile/`) at 1:1 parity with today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens` + the
N2 UI kit (`@vitana/ui`) on the Wave 1 N3 shell, with fixture / fake-gateway unit tests. Does **not** need G1 planned
or built to land the ports; every device-runtime verification step is marked depends-on-owner (G1). No redesign
(program §4), no new web screen, no `App.tsx` route, no registry/manifest change — only native route files and
parity-row status flips.
## Measured state (worktree = origin/main, parity ledger `apps/mobile/parity/ledger.json` version 2)
- **37 rows** carry `"lane": "profile-settings-support"`, **all `status: "not_started"`** (35 registry `screen`, 2
  `exclusion` `route`); **435 rows total**. Counted with `node -e` over the committed ledger (the `--report` CLI
  needs `typescript`, not installed in this worktree). The 37 rows and their web paths are listed in
  `requirements.md` R0.2–R0.4 and partitioned in `design.md` §3.
- **Query variants collapse to one route file.** Many rows are `?mode=` / `?tab=` / `?section=` / `?match_intent=`
  variants: `shapeOf()` (`scripts/native/parity-ledger.mjs:60`) drops the query, so each variant is matched by the
  **same** native route file reading its search param (as the web reads `useSearchParams()`). The 37 rows map to
  **12 native route files**: profile 4, settings 5, support-connectors 3.
- Web sources verified present with line counts: `src/pages/EditProfilePage.tsx` (739, `/me/profile`),
  `PublicProfilePage.tsx` (413, `/u/:identifier`), `PrivacySettings.tsx` (301, `/profile/me/privacy`),
  `MobileSettings.tsx` (603, the `?mode=` hub — `VALID_SECTIONS` `:39-44`), `settings/Limitations.tsx` (491),
  `settings/TenantRole.tsx` (388), `legal/DeleteAccount.tsx` (`/delete-account`), `MobileSupport.tsx` (819, the
  member support `?tab=` surface — tabs `:43-98`), `settings/ConnectedApps.tsx` (2111, the `?tab=` connectors
  directory — `activeTab` `:105,2180`); routes at `src/App.tsx:689-692` (settings router),
  `:715-718` (support router), `:1414-1467` (settings sections), `:1476-1505` (profile), `:847` (delete-account).
  (These line counts are an **approximate** scoping snapshot; exact counts are not load-bearing. The ONE
  load-bearing fact — that `MobileSettings`/`MobileSupport`/`ConnectedApps` are single `?param=` screens, so their
  many rows share one route file each — is confirmed at the pinned commit: `MobileSettings` `VALID_SECTIONS`
  `:39-44`, `MobileSupport` `normalizeTab` `:43-98`, `ConnectedApps` `activeTab` `:105`.)
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging hosts.
## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Five disjoint lanes by cluster and auth boundary** (prompt: 2–3 disjoint lanes; `delete-account` and
   `public-profile` are the public-route splits of decisions 1a and 1b). The sources show three separable clusters:
   **`profile`** (own profile + privacy: `/me/profile`, `/profile/me/privacy`), **`public-profile`** (the public
   `/u/:identifier` page and the legacy `/profile/:id` redirect, decision 1b), **`settings`** (the one `MobileSettings` `?mode=` hub + its standalone sub-screens
   `/settings/preferences`, `/settings/limitations`, `/settings/tenant-role`), **`delete-account`** (the public
   `/delete-account` page, decision 1a), and
   **`support-connectors`** (the member support `?tab=` surface `/support` + the connectors `?tab=` directory
   `/connectors` + `/settings/connected-apps`). The three touch disjoint route files and `src/screens/` subtrees,
   build/review independently, each leaves the app buildable. **Partition (verified against the ledger): profile 2
   rows, public-profile 3 rows, settings 17 rows, delete-account 1 row, support-connectors 14 rows = 37** (0 overlap, 0 orphan; each row
   named in its lane file or, for the split, in `tasks.md`).
   Support + connectors are one lane because both are small member-facing service surfaces and pairing them balances
   the lane sizes.
1a. **`/delete-account` is public on the web and stays public natively — its own lane, in the `(public)` group
   (r2 sparring R1-F1).** `src/App.tsx:843-847` places `/delete-account` in the "Public Routes - No Auth Required"
   block (with `/reset-password`, `/privacy`, `/terms`), while every other settings route (`:1414-1465`) is wrapped
   in `<AuthGuard>`; `DeleteAccount.tsx` handles both a signed-in member and a signed-out visitor. In the native app
   `apps/mobile/app/(app)/_layout.tsx` wraps every `(app)` route in `AuthGate`, which sends a signed-out visitor to
   `/maxina?redirectTo=…` unless the path is in `GUEST_PATHS`, and `GUEST_PATHS` may only hold `<AuthGuard
   allowGuest>` routes (checked by `scripts/native/check-shell-pins.mjs`). So the twin goes in the existing
   `(public)` group as `apps/mobile/app/(public)/delete-account.tsx` (no shell chrome, no auth gate — where the
   native `/reset-password` twin already lives) and reads the session itself: signed out → the same info/sign-in
   prompt the web shows, signed in → the confirm flow. A `_plan` commit may not edit an existing lane file
   (`queue.mjs` validateRange), and the `settings` lane file declares `apps/mobile/app/(app)/delete-account.tsx`, so
   the port is a new lane `delete-account` (`lanes/delete-account.md`). The `settings` lane no longer ports
   `/delete-account`: where its lane file still names it, `(app)/delete-account.tsx` or 18 rows, this plan block and
   its `tasks.md` section (17 rows → 4 files) govern, and the unused path entry creates nothing.
1b. **`/u/:identifier` and `/profile/:id` are public on the web too — lane `public-profile`, in the `(public)`
   group (r2 sparring R2-F1).** `src/App.tsx:1493` (`/u/:identifier` → `PublicProfilePage`) and `:1482`
   (`/profile/:id` → `LegacyProfileRedirect`) have no `AuthGuard`; neither is in `GUEST_PATHS`
   (`apps/mobile/src/navigation/guest-paths.ts:7-15`, `allowGuest` routes only), so under `(app)/` the native
   `AuthGate` (`AuthGate.tsx:44-46`) would send a signed-out visitor to `/maxina`. The twins go in `(public)`:
   `apps/mobile/app/(public)/u/[identifier].tsx` and `apps/mobile/app/(public)/profile/[id].tsx` (the latter resolves
   the id and navigates to the canonical `/u/…` profile, as the web redirect does). `PublicProfilePage` renders inside
   `AppLayout` for every visitor, so the native screen mirrors `(app)/_layout.tsx`'s split itself: wrapped in
   `MobileAppShell` when a session exists and in `PublicShell` when not (the same two shells `AuthGate` chooses
   between). Adding the paths to `GUEST_PATHS` is not an option (`check-shell-pins.mjs` admits only `allowGuest`
   routes) and deferring would ship a known parity break. The `profile` lane file declares the `(app)/u/…` and
   `(app)/profile/[id].tsx` paths and a `_plan` commit may not edit it, so the port is a new lane `public-profile`
   (`lanes/public-profile.md`, screens under `apps/mobile/src/screens/public-profile/**`). The `profile` lane keeps
   `/me/profile` and `/profile/me/privacy` (2 rows → 2 files); where its lane file still names the public rows, the
   `(app)/u/[identifier].tsx` / `(app)/profile/[id].tsx` paths or 5 rows, this plan block and its `tasks.md` section
   govern, and the unused path entries create nothing. Every other route in this plan was checked against
   `src/App.tsx`: the remaining profile, settings and support-connectors routes are inside `<AuthGuard>`, except
   `/settings/connected-apps` (`:1451`), a redirect to the guarded `/connectors`, where the `(app)` gate gives the same
   sign-in outcome.
2. **No `@vitana/core` extraction in this plan — and NEVER a class-B module into core.** Unlike the sibling
   home-feed plan (which extracted pure `feed-compose`/`news-feed-ranker`), this cluster's screens are driven by
   **data-fetching hooks that runtime-import the web Supabase client** — `useProfileGallery`, `useProfileMilestones`,
   `useNotificationPreferences`, `useNotificationCategoryPreferences`, `useWearableProviders`, `useSocialPlatforms`,
   `useAutopilot` and friends (verified: these import `@/hooks/*` / `@/lib/*` that reach
   `@/integrations/supabase/client`, `import.meta.env`, `localStorage` — class B). They would fail
   `core-closure.mjs --check` (`m.own !== 'A'`) exactly as the sibling's feed hooks did, so per the Wave-1 pattern
   the `home` lane used, the lanes **re-implement the fetching natively** (native Supabase client + native auth
   context) and consume any already-exported pure helper from core. Consequently **no lane lists the
   `packages/core/{manifest.json,closure.generated.json,src/**}` or `scripts/native/mobile-ci-paths.generated.json`
   paths, and no lane runs `core-closure --write`.** If implementation finds a genuinely new class-A helper is
   required, that is a plan change (log it, `next_actor: claude`), not a silent scope widening; a class-B hook is
   never moved into core.
3. **Support + connectors share one lane; admin/dev support and partner-connections are out of scope.** The only
   `profile-settings-support` support/connector rows are the member-facing `MobileSupport` (`/support`) and
   `ConnectedApps` (`/connectors`, `/settings/connected-apps`). The partner-connections screens
   (`PartnerConnections.tsx` / `PartnerConnectionDetail.tsx`) are `requiredRole="admin"` (`src/App.tsx:1819,1822`)
   and carry no ledger row; the Commerce connector docs/authorize pages likewise. All are explicitly excluded
   (requirements R0.5). **No lane depends on another — all five run in parallel.**
4. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; a native Expo
   Router file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest +
   parity rows" rule does not fire — only parity-row **status** flips (`not_started`→`in_progress`→`native`). The
   `/settings/connected-apps` row (web redirects it to `/connectors`) gets its own native file in the
   `support-connectors` lane mirroring the redirect, so its dedicated shape goes `native` (`shapeOf` matches exactly,
   not by prefix — `parity-ledger.mjs:60`).
5. **Device-runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit
   tests green; the Maestro / simulator / screenshot-parity pass is a `next_actor: owner` task recorded in the lane
   and `staging-tests.json`. **This cluster is all WRITE surfaces** (profile edits, settings toggles, support
   submissions, connector connect/disconnect, account deletion), so standing rule 31/31b applies: those writes land
   in the single production Supabase project / gateway on every host, so build-time verification is **fixture /
   fake-gateway unit tests only** (a save asserts the built request against a mocked gateway and fires nothing), and
   the G1 device-runtime pass must use the isolated test environment, never a live backend as the test account.
   Matches the program's "fixture / fake-gateway tests only until G1" model.
6. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its source
   (`MobileSettings` / `MobileSupport`, and the mobile branch of the profile/privacy screens), composed through
   N3/N2, every visual value from `@vitana/tokens`; the four N2-documented web defects are not reproduced and no web
   file is touched beyond a DE-first i18n key. The non-`VALID_SECTIONS` `accessibility` param
   (`SETTINGS.PREFERENCES_ACCESSIBILITY`) reproduces the current web fallback, inventing no new section
   (requirements R1.5).
## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `profile` | exafyltd → hotmail | `/me/profile` (EditProfilePage), `/profile/me/privacy` — **2 rows → 2 files** | — |
| `public-profile` | exafyltd → hotmail | `/u/:identifier` (+`?match_intent=`), `/profile/:id` (legacy redirect), both public in `(public)` (decision 1b) — **3 rows → 2 files** | — |
| `settings` | exafyltd → hotmail | `/settings` (the `?mode=` hub, 14 rows = `SETTINGS.OVERVIEW` + 13 `?mode=`), `/settings/preferences?section=`, `/settings/limitations`, `/settings/tenant-role` — **17 rows → 4 files** | — |
| `delete-account` | exafyltd → hotmail | `/delete-account` (public, `app/(public)/delete-account.tsx`, decision 1a) — **1 row → 1 file** | — |
| `support-connectors` | exafyltd → hotmail | `/support` (+`?tab=`, 4 rows), `/connectors` (+`?tab=` + `SETTINGS.SOCIAL`, 9 rows), `/settings/connected-apps` — **14 rows → 3 files** | — |
Exact `paths` globs are in each `lanes/<id>.md`; the 37 parity rows partition **2 (profile) + 3 (public-profile) + 17
(settings) + 1 (delete-account) + 14 (support-connectors)** with 0 overlap and 0 orphan. The one shared directory `apps/mobile/app/(app)/settings/` is
split by explicit file names between `settings` and `support-connectors` (design §1a) — no file in two lanes. All
five lanes run in parallel (no dependencies).
## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; **every write — profile save, settings toggle, support submit,
  connector connect/disconnect, account delete — asserts the built request against a MOCKED gateway and fires
  nothing** (requirements R5.2); each `?mode=`/`?tab=`/`?section=` section renders from its param; i18n no-raw-text +
  RTL start/end; React 19 `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native` by `shapeOf`, routes present).
- **No core extraction deliverable** (decision 2): no lane edits `packages/core/**` or runs `core-closure --write`.
  `node scripts/native/core-closure.mjs --check` stays green because nothing changes it. If a lane discovers it needs
  a new class-A helper, it stops and logs a plan change (`next_actor: claude`); it does not add core paths on its own.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form) then mirrored; RTL (`ar`)
  rendered per screen. New keys go in `src/i18n/*/<cluster>Native.json` (`profileNative`/`settingsNative`/
  `supportNative`); existing `screens.mobilesettings.*` / `screens.mobilesupport.*` keys are reused.
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/<cluster>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging web screen; listed
  in `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts every non-GET except
  sign-in; never `vitanaland.com`). For this write-heavy cluster the G1 run uses the isolated test environment, never
  a live backend as the test account. STAGING-VERIFY is read-only by construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native
  parity row — only status flips.
## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check; for this
  write-heavy cluster it must be a genuinely isolated Supabase/gateway, not a preview pointed at production. The
  deferred tasks stay `next_actor: owner` until it exists.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- Whether `support` and `connectors` should be two lanes instead of one (decision 3 default: one lane; split is a
  one-file move).
- Whether `/settings/connected-apps` native file renders `ConnectedApps` directly or redirects to `/connectors`
  (design §2c default: mirror the web redirect).
<!-- plan:end -->

<!-- cross-repo plan; vitana-v1 read via spar_refs. fresh session after PLAN-SPAR repair; 2026-10-28T09:50:36.9823176+01:00 -->
