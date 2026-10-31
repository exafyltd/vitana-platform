# Requirements — Native Wave 2: Profile / Settings / Support / Connectors screen ports (native-wave2-profile-settings)
Wave 2 screen-port batch of the Maxina native app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021). Port the profile, settings, support and
connectors screens that the parity ledger assigns to the `profile-settings-support` lane to the native app
(`apps/mobile/`) at 1:1 parity with today's **mobile web** screens, built on `@vitana/core` + `@vitana/tokens` +
the N2 UI kit (`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime verification on a device
needs the isolated test environment G1 and is called out per task as `depends-on-owner`.
Measured on the worktree (= `origin/main`), parity ledger `apps/mobile/parity/ledger.json` version 2:
**37 rows carry `"lane": "profile-settings-support"`, every one `status: "not_started"`** (35 `screen` from the
registry, 2 `route` from `exclusion`; 435 rows total). Counted with `node -e` over the committed ledger JSON (the
`--report` command needs `typescript`, which is not installed in this worktree). The three lanes below partition
those 37 rows with **disjoint `paths`**.
Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §4 (parity method), §6 (verification &
safety), the N2 README web→native prop map (`apps/mobile/README.md` "Web → native prop map"), and the Spotlight /
design rules via tokens. No new web screen, no `App.tsx` route, no `screens.json` / `exclusions.json` entry is added
by this plan (ports only), so no `screen-manifest` or voice-registry change and no new native parity row — only
status flips on existing rows.
## R0 — Scope and the three lanes
0.1 The plan ports exactly the 37 web destinations the parity ledger lists under `"lane": "profile-settings-support"`,
split into three disjoint lanes by cluster. No row is in two lanes; no row in scope is left without a lane. Many
rows are `?mode=` / `?tab=` / `?section=` / `?match_intent=` query variants of the same base path: `shapeOf()`
(`scripts/native/parity-ledger.mjs:60`) drops the query, so each query variant is matched by the **same** native
route file reading its search param (exactly as the web screen reads `useSearchParams()`). The 37 rows therefore
map to **12 distinct native route files** across the three lanes.
0.2 Lane **`profile`** — the member's own profile (view + edit), the public profile, and the privacy screen
(**5 rows → 4 route files**):
`PROFILE.ME /me/profile` (web `src/pages/EditProfilePage.tsx`, 739 lines; route `src/App.tsx:1483-1487`, element
`EditProfilePage`), `PROFILE.PUBLIC /u/:identifier` and `PROFILE.WITH_MATCH /u/:identifier?match_intent=:intent_id`
(both shape `/u/:` — web `src/pages/PublicProfilePage.tsx`, 413 lines; route `src/App.tsx:1493`),
`PROFILE.PRIVACY /profile/me/privacy` (web `src/pages/PrivacySettings.tsx`, 301 lines; route
`src/App.tsx:1501-1505`), and the legacy exclusion route `/profile/:id` (web `LegacyProfileRedirect`, route
`src/App.tsx:1482`). Mobile `/me/profile` IS `EditProfilePage` (profile view + inline edit drawers); there is no
separate `/profile` member route (`/profile` redirects to `/me/profile`, `src/App.tsx:1476`).
0.3 Lane **`settings`** — the unified mobile settings screen and its standalone sub-screens
(**18 rows → 5 route files**):
`SETTINGS.OVERVIEW /settings` plus the `?mode=` sections rendered by the one `MobileSettings` screen —
`SETTINGS.NOTIFICATIONS`, `SETTINGS.PRIVACY` (+`.visibility`, `.data`, `.security`), `SETTINGS.PREFERENCES`
(+`.appearance`, `.language`), `SETTINGS.BILLING` (+`.plan`, `.payment`, `.invoices`, `.creator`) — **14 rows, all
shape `/settings`** (`SETTINGS.OVERVIEW` is the bare `/settings`, the other 13 are `?mode=` variants) (web
`src/pages/MobileSettings.tsx`, 603 lines; `VALID_SECTIONS` at `:39-44`; router
`src/App.tsx:689-692`, sections `:1414-1467`). Plus three standalone routes and one exclusion:
`SETTINGS.PREFERENCES_ACCESSIBILITY /settings/preferences?section=accessibility` (shape `/settings/preferences`;
**note: `accessibility` is NOT in `MobileSettings` `VALID_SECTIONS`** — see R1.5),
`SETTINGS.LIMITATIONS /settings/limitations` (web `src/pages/settings/Limitations.tsx`, 491 lines; route
`src/App.tsx:1436-1440`), `SETTINGS.TENANT_ROLE /settings/tenant-role` (web `src/pages/settings/TenantRole.tsx`,
388 lines; route `src/App.tsx:1454-1460`), and the exclusion route `/delete-account` (web
`src/pages/legal/DeleteAccount.tsx`; route `src/App.tsx:847`).
0.4 Lane **`support-connectors`** — the member-facing support surface and the connected-apps directory
(**14 rows → 3 route files**):
`SETTINGS.SUPPORT /support` plus `SETTINGS.SUPPORT_CONTACT /support?tab=contact`,
`SETTINGS.SUPPORT_COMMUNITY /support?tab=community`, `SETTINGS.SUPPORT_FAQ /support?tab=faqs` — **4 rows, all shape
`/support`** (web mobile `src/pages/MobileSupport.tsx`, 819 lines; router `src/App.tsx:715-718`; tabs
`MobileSupport.tsx:43-98`); the eight `CONNECTORS.* /connectors?tab=<agent|ai|fitness|health|media|other|
productivity|social>` rows plus `SETTINGS.SOCIAL /connectors` — **9 rows, all shape `/connectors`** (web
`src/pages/settings/ConnectedApps.tsx`, 2111 lines; route `src/App.tsx:1441-1445`; tabs via `activeTab`
`ConnectedApps.tsx:105,2180`); and `SETTINGS.CONNECTED_APPS /settings/connected-apps` (shape
`/settings/connected-apps`; on web a redirect to `/connectors`, `src/App.tsx:1451` — its own ledger row and shape,
so a dedicated native route file, see R0.5).
0.5 **Member-facing only.** The support lane ports the member in-app support surface (`MobileSupport.tsx`: the
Contact / report-to-Vitana form that POSTs to `/api/v1/feedback/tickets`, My Tickets, FAQs, Community tabs, and the
ORB support-report activation `activateOrbForSupportReport`). It **excludes** admin / dev / operator support and
partner-connection tooling: `src/pages/PartnerConnections.tsx` and `src/pages/PartnerConnectionDetail.tsx` are
`requiredRole="admin"` routes (`src/App.tsx:1819,1822`) and are **out of scope**; so are the Commerce connector docs
/ authorize pages (`CommerceConnect*`) and every `admin/`/`dev/`/`backoffice/` settings screen — none carry a
`profile-settings-support` ledger row.
## R1 — 1:1 parity with the mobile web screen
1.1 Each native screen mirrors the **mobile web** branch (the `useIsMobile()` ≤ 1024 px branch,
`src/hooks/use-mobile.tsx`) of its web source — same layout, same sections, same navigation, same wording. No
redesign, no added or removed section, no reordering (program §4 "Allowed native improvements only": platform
transitions, gestures, keyboard avoidance, safe areas, haptics, system sheets — nothing else).
1.2 Screens compose through the N3 shell and the N2 UI kit only: `MobileAppShell`, `TopAppBar`, `BottomNav`,
`MobileModePill`, bottom sheets, `VCard`, `SplitBar`, `Select`, `Slider`, `Progress`, etc. come from `src/ports/*`
(`apps/mobile/README.md` "Ports"); no web component, no raw colour, every visual value from `@vitana/tokens`.
1.3 Web→native translation follows the README map exactly (`onClick`→`onPress`, `className`→`style`,
`toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, documented `Select`/`Tooltip`/close-button/`Slider`/`Progress`
differences). The four web defects the N2 README lists (slider range thumb, progress RTL fill, inert
`shouldScaleBackground`, close-button RTL side) are **not** reproduced — the native kit's corrected behaviour is
used, and no web file is touched.
1.4 Business logic, query keys, types and pure helpers are reused from `@vitana/core` when a pure (class-A) module
already exists or can be added; data-fetching hooks that runtime-import the web Supabase client (class-B) are
**re-implemented natively** against the native Supabase client + native auth context (the Wave-1 pattern the `home`
lane used for the feed hooks), never re-implemented as new web modules and never moved into core (see design §4
decision 2). `@vitana/core` is the only web→native bridge; ESLint bans `@/` and relative paths into the web `src/`
from app code.
1.5 **Accessibility section fidelity.** `SETTINGS.PREFERENCES_ACCESSIBILITY` points at
`/settings/preferences?section=accessibility`, but `accessibility` is not one of `MobileSettings`' `VALID_SECTIONS`
(`src/pages/MobileSettings.tsx:39-44`, which fall back to `notifications`). The native `/settings/preferences`
route reproduces the **current mobile-web behaviour** for that param (the fallback the web shows today), not a new
accessibility screen — porting invents no section the web does not render (program §4). If the web later adds a real
accessibility section, the native parity follows then, as a separate change.
## R2 — i18n (11 locales) + RTL
2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog
shards `src/i18n/<locale>/*.json`, read through the generated catalog map — no hardcoded text (repo i18n hard rule;
`apps/mobile/README.md` "i18n"). These screens already reference keys under `screens.mobilesettings.*`,
`screens.mobilesupport.*`, etc. via `t(...)`; the native twins reuse those keys.
2.2 All 11 active locales resolve: **ar de en es fr pl pt ru sr tr zh** (program §1 design-system note; the live
`supported_locales` table has all 11 `status='ga'`). A new key is added to the **German shard first**
(`src/i18n/de/<screen>.json`) then mirrored to the other ten; DE is du-form.
2.3 Each screen works in RTL (`ar`): `start`/`end`, never `left`/`right`; the shell root `direction` follows the
language (`apps/mobile/README.md` N3 "Theme" row). A test scans the lane's files for physical `left`/`right`.
2.4 Adding a web i18n key is a web-deploy path. A lane that needs a genuinely new string adds the DE key first and
mirrors it; a lane that can reuse an existing key does so and adds none.
## R3 — React 19 / native typing
3.1 React 19 types: no global `JSX` namespace — use `ReactElement` (program hard rule; `.kiro/specs/health-native`
handoff "Hard rules"). `npm run typecheck` (which regenerates the i18n map first) is green.
## R4 — Parity ledger
4.1 Each lane flips its rows from `not_started` to `in_progress` while building and to `native` on completion by
running `node scripts/native/parity-ledger.mjs --sync` (status is edited by hand; `--sync` refreshes derived fields),
and NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route (by `shapeOf`) in
`apps/mobile/app/`, and no route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`). A query
variant row (`?mode=`/`?tab=`/`?section=`) is satisfied by the single route file for its base shape.
4.2 No lane changes `scope`/`lane` of a row (those come from `scripts/native/parity-scope.json`); no lane edits
another lane's rows. The three lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is the one
shared path and conflicts resolve by row.
## R5 — Verification and safety (never production — this is an all-WRITE cluster)
5.1 **This cluster is almost entirely WRITE surfaces for the member account** — profile edits (avatar, about,
identity, galleries), settings toggles (notifications, privacy, preferences, billing), onboarding / account steps,
and support submissions (`MobileSupport` POSTs to `/api/v1/feedback/tickets`). Standing rule 31/31b: every such
write lands in the single production Supabase project / production gateway regardless of host (preview/staging
included), so running any of these flows as the test account is **FORBIDDEN on every host**. Reading is fine
everywhere; writing is fine nowhere.
5.2 **Verification is fixture / fake-gateway unit tests ONLY.** Build-time verification per lane is offline:
`npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with a **fake gateway / fixtures**, no network — a save
asserts the right request is *built*, with the gateway mocked; it never fires a real write), `APP_PROFILE=development
npm run bundle`, and `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` — all from `apps/mobile/`; plus
`node scripts/native/parity-ledger.mjs --check` from the repo root. **No live call, no real write, no Playwright
against a real backend.** The native app has no production profile and `assertNotProduction()` refuses the production
gateway, `vitanaland.com`, the production Supabase project and the staging hosts (`apps/mobile/README.md` "No
production host, ever").
5.3 Runtime parity verification (simulator / emulator screenshots, Maestro device journeys, screenshot parity vs the
390×844 web screen) is a **depends-on-owner (G1)** step: it needs the isolated test environment (and macOS minutes /
G3 for iOS on a device). Each such task is marked `next_actor: owner` in `tasks.md` and the lane records G1 as a
blocker in its log; it does not block the build-time port landing. **Maestro flows under
`apps/mobile/maestro/<cluster>/**` may be authored as artifacts but are NOT run against production in this wave** —
they run at G1 only, and for this write-heavy cluster a G1 run must use the isolated test environment, never a live
backend as the test account.
5.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by CI
after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET except
sign-in; never `vitanaland.com`. For this cluster the read-only guard is doubly important — the screens' own buttons
are writes, so the spec only renders/reads and never submits.
5.5 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New rule).
## R6 — Done
6.1 Every in-scope ledger row for the lane is `native` with a native route for its base shape in `apps/mobile/app/`
and its functional-parity checklist (program §4 per-screen checklist) recorded; RTL (`ar`) covered.
6.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check` and `parity-ledger --check` green;
NATIVE-CI (incl. the shell source-pin and ports checks) and the Collab handoff + Lane scope PR-GATE checks green.
6.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only spec)
and `plan-sparring.md` (copy of this plan's sparring record).
## Out of scope (named so a lane does not drift into them)
- Any screen in another Wave 2 ledger lane (`home-feed`, `events-calendar`, `media`, `ai`, `discover-commerce`,
  `inbox-chat-calls`, `wallet`, `role-modes`, `health`, `memory-diary`, etc.) — each is its own plan.
- Admin / dev / operator / backoffice settings and support tooling, partner connections
  (`PartnerConnections.tsx` / `PartnerConnectionDetail.tsx`, `requiredRole="admin"`), and the Commerce connector
  docs/authorize pages (`CommerceConnect*`) — none carry a `profile-settings-support` ledger row (R0.5).
- The desktop standalone settings pages (`src/pages/settings/Privacy.tsx`, `Preferences.tsx`,
  `SettingsNotifications.tsx`, `Billing.tsx`, `Support.tsx`) as desktop layouts — the native target is the
  `useIsMobile()` branch (`MobileSettings` / `MobileSupport`), not the desktop twin.
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module — their own plans / owner gates.
- Any web-side change beyond adding an i18n key (DE first); **no `@vitana/core` extraction in this plan** (design §4
  decision 2 — the cluster's hooks are class-B data hooks, re-implemented natively, never moved into core).
