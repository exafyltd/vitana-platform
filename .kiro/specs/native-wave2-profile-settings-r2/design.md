# Design — Native Wave 2: Profile / Settings / Support / Connectors screen ports (native-wave2-profile-settings-r2)
How the three lanes port the `profile-settings-support` ledger cluster to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture) and §4 (parity method), the N3 shell and N2 UI kit
already on main, and `apps/mobile/README.md`. Nothing here changes the program plan or the design contract.
## 1. Where native screens live and how they resolve
Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console, unknown as not-found
(`apps/mobile/parity/ledger.json` `native_only` entry for `/*`). Porting a screen means **adding its own Expo Router
file under `apps/mobile/app/`** whose route path equals the web path, so the resolver no longer catches it, the push
`data.url` / universal link / ORB directive resolve the same, and the parity row can go `native`
(`scripts/native/parity-ledger.mjs` `fileToRoute()` maps `app/(app)/foo/[id].tsx` → `/foo/:id`;
`shapeOf()` at `:60` drops the query so a `?mode=`/`?tab=`/`?section=` variant matches the same file).
Route-file plan (Expo Router, paths = web paths) — **12 files for 37 rows**:
| Lane | Native route file(s) under `apps/mobile/app/` | Web path(s) / rows |
|---|---|---|
| `profile` | `(app)/me/profile.tsx`, `(app)/u/[identifier].tsx`, `(app)/profile/me/privacy.tsx`, `(app)/profile/[id].tsx` | `/me/profile`; `/u/:identifier` (+`?match_intent=`); `/profile/me/privacy`; `/profile/:id` (legacy redirect) |
| `settings` | `(app)/settings/index.tsx` (all `?mode=` sections), `(app)/settings/preferences.tsx`, `(app)/settings/limitations.tsx`, `(app)/settings/tenant-role.tsx`, `(app)/delete-account.tsx` | `/settings` (+13 `?mode=` rows); `/settings/preferences?section=`; `/settings/limitations`; `/settings/tenant-role`; `/delete-account` |
| `support-connectors` | `(app)/support.tsx` (all `?tab=` sections), `(app)/connectors.tsx` (all `?tab=` + `SETTINGS.SOCIAL`), `(app)/settings/connected-apps.tsx` | `/support` (+3 `?tab=` rows); `/connectors` (+8 `?tab=` + `/connectors`); `/settings/connected-apps` |
Query-string variants (`?mode=`, `?tab=`, `?section=`, `?match_intent=`) are the **same route file** reading the
search param, exactly as the web screen reads `useSearchParams()` — distinct ledger rows, one file. The ledger's
shape-matching (`shapeOf`, query dropped) is satisfied by the single file.
## 1a. Disjointness of the shared `app/(app)/settings/` folder (the one tricky seam)
`settings` owns `/settings`, `/settings/preferences`, `/settings/limitations`, `/settings/tenant-role`;
`support-connectors` owns `/settings/connected-apps` (a dedicated ledger row/shape, because web redirects it to
`/connectors` but the ledger keeps it as its own `SETTINGS.CONNECTED_APPS` shape). Both therefore place a file
under `apps/mobile/app/(app)/settings/`. To keep the two lanes' `paths` truly disjoint **at the file level** (the
Lane-scope check matches each changed file against the lane's declared globs, `scripts/collab/queue.mjs` `scopeCheck`):
- `settings` declares the specific files it creates under that folder — `app/(app)/settings/index.tsx`,
  `app/(app)/settings/preferences.tsx`, `app/(app)/settings/limitations.tsx`, `app/(app)/settings/tenant-role.tsx`
  (NOT a bare `app/(app)/settings/**`), so it never claims `connected-apps.tsx`.
- `support-connectors` declares the single file `app/(app)/settings/connected-apps.tsx` plus its own
  `app/(app)/support.tsx` and `app/(app)/connectors.tsx`.
No file is in two lanes; the two lanes share the `settings/` directory but never the same file. Each lane's own
`src/screens/<cluster>/` subtree (`src/screens/profile/`, `src/screens/settings/`, `src/screens/support/`) is fully
disjoint.
## 2. Screen source: the N2/N3 structure, not the web DOM
Each lane re-implements the **mobile web** branch of its source screen with React Native primitives:
- Imports go through ports only: `@vitana/core/*` (pure helpers, query keys, types), `@vitana/ui` (UI kit),
  `@vitana/tokens` (visual values), `src/ports/*` from the shell (`core`, `ui`, `links`, `badges`, `soundscape`,
  `orb-slot`, `env`, `tokens`). No `@/…` web import (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`,
  shadcn `Card`→`VCard`/`Panel`, `Dialog`/`Sheet`/`ResponsiveDialog`→the kit's modal / bottom sheet,
  `toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, list/scroll→`FlatList`/`ScrollView`, `Select`/`Slider`/
  `Progress`/`SplitBar`→the kit's corrected twins.
### 2a. Profile lane specifics (view + edit drawers)
`/me/profile` IS `EditProfilePage` (`src/pages/EditProfilePage.tsx`, 739 lines) — the member's own profile with
inline edit drawers (About, Identity, Visibility, Compliance, Services, Showcase, Dance/Partner preferences,
galleries), the avatar/cover upload fields, the profile-progress card, and the share sheet. The native twin renders
the mobile-web layout as a `ScrollView` of `VCard` sections; each editable section opens a native bottom sheet twin
of the matching web drawer (`src/components/profile/drawers/*`, `editor/*`). Avatar/cover/gallery uploads map to
`expo-image-picker` + the native upload path through a port, but **the upload itself is a write** — the port is
wired, the unit test asserts the request is *built* with the gateway mocked (R5.2), never fired. `/u/:identifier` is
the read-only public profile (`PublicProfilePage.tsx`), including the `?match_intent=` variant that highlights the
matching intent. `/profile/me/privacy` is the standalone privacy/visibility screen (`PrivacySettings.tsx`).
`/profile/:id` is a legacy redirect (web `LegacyProfileRedirect`) — the native file resolves the id and navigates to
the canonical profile, mirroring the web redirect, so the exclusion row goes `native`.
### 2b. Settings lane specifics (one screen, many `?mode=` sections)
`MobileSettings.tsx` (603 lines) is a single screen whose `?mode=` search param selects a section
(`VALID_SECTIONS` `:39-44`: `notifications`, `privacy[.visibility|.data|.security]`,
`preferences[.appearance|.language]`, `billing[.plan|.payment|.invoices|.creator]`), rendered through a
`MobileModePill`-style selector. The native `app/(app)/settings/index.tsx` reads the `mode` param and renders the
matching section, mirroring the web `switch` exactly — so **14 of the lane's rows (`SETTINGS.OVERVIEW` + 13 `?mode=`
variants) are one file**. The three
standalone screens each get their own file: `settings/preferences.tsx` (the `/settings/preferences?section=` route,
reproducing the web fallback for the non-`VALID_SECTIONS` `accessibility` param — requirements R1.5),
`settings/limitations.tsx` (`Limitations.tsx`, the plan/usage limits screen), `settings/tenant-role.tsx`
(`TenantRole.tsx`, the role switcher). `delete-account.tsx` ports the account-deletion flow
(`src/pages/legal/DeleteAccount.tsx`) — a destructive write surface, so the native screen renders the confirm UI
and the unit test asserts the delete request is *built* (gateway mocked), never fired (R5.2). All settings mutations
(toggle a notification category, change a preference, billing actions) go through the native data layer with the
gateway mocked in tests.
### 2c. Support + connectors lane specifics (member-facing only)
`MobileSupport.tsx` (819 lines) is the member support surface: a `?tab=` screen (`contact` / `tickets` / `faqs` /
`community`, `:43-98`) with the Contact/report-to-Vitana form (POST `/api/v1/feedback/tickets` via
`buildSupportContactBody`, `:448`), the member's own tickets list (`MyTicketsList`), the FAQ accordion, and the
community-help tab, plus the ORB support-report entry (`activateOrbForSupportReport`). The native
`app/(app)/support.tsx` reads `tab` and renders the matching tab; the Contact submit is a write — port wired, test
asserts the built request with the gateway mocked (R5.2), never fired. **Admin / operator support tooling and the
Devon-handoff operator console are NOT in scope** (requirements R0.5): the member-facing report that hands off to a
specialist is the `feedback/tickets` submission in `MobileSupport`, which is what the ledger rows cover.
`ConnectedApps.tsx` (2111 lines) is the connected-apps directory: a `?tab=`/`activeTab` screen over categories
(agent / ai / fitness / health / media / other / productivity / social, `APP_ORDER`) plus a "connected" view, with
connect/disconnect actions (writes — port wired, mocked in tests) and per-provider health cards
(`useWearableProviders`). The native `app/(app)/connectors.tsx` reads `tab` and renders the category; it also serves
`SETTINGS.SOCIAL /connectors` (same shape). `app/(app)/settings/connected-apps.tsx` is the dedicated route for the
`SETTINGS.CONNECTED_APPS` row (web redirects `/settings/connected-apps`→`/connectors`); the native file either
renders the same `ConnectedApps` screen or redirects to `/connectors`, mirroring the web redirect, so the row goes
`native`.
## 3. Disjointness (no overlap, no orphan)
- **Ledger rows:** the 37 `profile-settings-support` rows partition cleanly — `profile` 5
  (`PROFILE.ME`, `PROFILE.PUBLIC`, `PROFILE.WITH_MATCH`, `PROFILE.PRIVACY`, `/profile/:id`), `settings` 18
  (`SETTINGS.OVERVIEW` + the 13 `?mode=` rows + `SETTINGS.PREFERENCES_ACCESSIBILITY`, `SETTINGS.LIMITATIONS`,
  `SETTINGS.TENANT_ROLE`, `/delete-account`), `support-connectors` 14 (`SETTINGS.SUPPORT` + 3 `?tab=` rows, the 8
  `CONNECTORS.*` + `SETTINGS.SOCIAL`, `SETTINGS.CONNECTED_APPS`). 5 + 18 + 14 = 37. Each row named explicitly in the
  lane file.
- **Native files:** each lane owns a disjoint set of files under `apps/mobile/app/` and a disjoint
  `apps/mobile/src/screens/<cluster>/` subtree (`src/screens/profile/`, `src/screens/settings/`,
  `src/screens/support/`). The one shared directory `app/(app)/settings/` is split by explicit file names (§1a) — no
  file in two lanes.
- **Tests:** each lane owns `apps/mobile/tests/<cluster>/**` and `apps/mobile/maestro/<cluster>/**` and its
  `docs/validation/<VTID>/` folder (clusters: `profile`, `settings`, `support` — the support lane uses `support`).
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own rows) and the
  DE-first i18n shards `src/i18n/*/<clusterName>Native.json` (`profileNative.json`, `settingsNative.json`,
  `supportNative.json` — each lane adds only its screens' keys). These are listed in each lane's `paths`.
## 4. Decisions (made by Kiro as planner; sparring may revise)
1. **Three lanes, not one or two.** The prompt asks for 2–3 disjoint lanes by cluster. The sources show three
   genuinely separable clusters: `profile` (member/public profile + privacy, `/me/profile`, `/u/:`, `/profile/me/
   privacy`, `/profile/:id`), `settings` (the one `MobileSettings` screen + its standalone sub-screens + account
   deletion), and `support-connectors` (the member support surface + the connected-apps directory). They touch
   disjoint route files and `src/screens/` subtrees, build and review independently, and each leaves the app
   buildable. Support and connectors are paired into one lane because both are small member-facing "service" surfaces
   and together they balance the lane sizes (14 rows vs settings' 18 vs profile's 5). Rationale recorded here per
   planning-mode rule.
2. **No `@vitana/core` extraction in this plan — and NEVER a class-B module into core.** Unlike the sibling
   home-feed plan (which extracted the pure `feed-compose`/`news-feed-ranker` modules), this cluster's screens are
   driven by **data-fetching hooks that runtime-import the web Supabase client** — e.g. `useProfileGallery`,
   `useProfileMilestones`, `useNotificationPreferences`, `useNotificationCategoryPreferences`, `useWearableProviders`,
   `useSocialPlatforms`, `useAutopilot`. Those are **class B** (they reach `@/integrations/supabase/client`,
   `import.meta.env`, `localStorage`) and would fail `core-closure.mjs --check` (`m.own !== 'A'`) exactly as the
   sibling's feed hooks did. Per the Wave-1 pattern the `home` lane used, the lanes **re-implement the fetching
   natively** (native Supabase client + native auth context) and consume any already-exported pure helper from core.
   The pure helpers these screens use (`buildSupportContactBody`/`feedback-ticket`, `connected-apps-client` `APP_ORDER`,
   `profileScope`, `locale-format`) are small, IO-free candidates; if a lane genuinely needs one that is not yet
   re-exported, adding it is a class-A core re-export + `core-closure.mjs --write` in that lane's PR — but the plan's
   measured expectation is that the screens reuse what exists and re-implement the data hooks, so **no lane lists the
   `packages/core/{manifest.json,closure.generated.json,src/**}` or `scripts/native/mobile-ci-paths.generated.json`
   paths**, and none runs `core-closure --write`. If sparring or implementation finds a required new class-A
   extraction, that is a plan change (log it, `next_actor: claude`) — it does not silently widen a lane's scope, and
   it never moves a class-B hook into core.
3. **Support + connectors share one lane; partner-connections / admin support are out.** The member-facing support
   (`MobileSupport`) and connected-apps (`ConnectedApps`) are the only `profile-settings-support` support/connector
   rows; the admin partner-connections screens are `requiredRole="admin"` and carry no ledger row (requirements
   R0.5), so they are explicitly excluded. One owner for both member surfaces keeps `paths` disjoint from the other
   two lanes.
4. **No new routes / registry / manifest.** These are ports of screens that already exist in `App.tsx` and
   `screens.json`; adding a native route file is not an `App.tsx` route, so the "new page needs
   screens.json/exclusions.json + screen-manifest + parity rows" rule does not fire — only parity-row **status**
   flips (`not_started`→`in_progress`→`native`). The lanes add native route files and status flips, nothing in
   `src/navigation/registry/`.
5. **Runtime verification is deferred to G1** (owner gate). Lanes land the ports with offline build + fake-gateway
   unit tests green; the simulator/Maestro/screenshot-parity pass is a `next_actor: owner` task recorded in the lane
   and the `staging-tests.json`. **This cluster is write-heavy, so the G1 run must use the isolated test environment,
   never a live backend as the test account** (requirements R5.1/R5.3). Maestro flows may be authored as artifacts
   now but are not run against production in this wave.
6. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its source
   (`MobileSettings` / `MobileSupport`, and the mobile branch of the profile/privacy screens), composed through
   N3/N2, every visual value from `@vitana/tokens`; the four N2-documented web defects are not reproduced and no web
   file is touched beyond a DE-first i18n key.
## 5. Test design (per lane) — fixture / fake-gateway only (R5.2)
- **Unit (jest-expo + RNTL, fake gateway, no network):** each screen renders its loaded state from fixture data, its
  empty state and its error state. For write surfaces (profile save, settings toggle, support submit, connector
  connect/disconnect, account delete) the test asserts the **built request** (method, path, body) against a **mocked
  gateway** and asserts no real request is fired — never a live write. For the `?mode=`/`?tab=`/`?section=` screens,
  a test per section asserts the param selects the right section (settings 13 modes, support 4 tabs, connectors 8+
  tabs). Pure-module tests for any core helper a lane adds.
- **i18n/RTL:** a test asserts no hardcoded user-visible string in the lane's screens and no physical `left`/`right`;
  renders one screen under `ar` (RTL) and asserts start/end usage.
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Parity:** `node scripts/native/parity-ledger.mjs --check` from the repo root (rows `native`, routes present by
  `shapeOf`).
- **Deferred (G1, `next_actor: owner`):** Maestro journeys `maestro/<cluster>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 read-only staging web screen, listed in
  `docs/validation/<VTID>/staging-tests.json` — all on the isolated G1 environment, never a live backend.
## 6. Open items for the owner / sparring
- G1 isolated test environment (program gate) is required before any device-runtime parity check; until then the
  deferred tasks stay `next_actor: owner`. For this write-heavy cluster G1 must be a genuinely isolated Supabase/
  gateway, not a preview pointed at production.
- Whether `support` and `connectors` should be two lanes instead of one (decision 3 default: one lane; split is a
  one-file move if sparring prefers it).
- Whether `/settings/connected-apps` native file should render `ConnectedApps` directly or redirect to `/connectors`
  (design §2c default: mirror the web redirect; either keeps the row `native`).
