# Tasks — Native Wave 2: Profile / Settings / Support / Connectors screen ports
Five lanes, disjoint `paths` (`delete-account` added by r2 sparring R1-F1, plan decision 1a; `public-profile` by
R2-F1, decision 1b). Design: `design.md` and `requirements.md` in this folder are authoritative — follow
them exactly; anything outside them is a plan change (log it, set `next_actor: claude`). VTIDs are assigned by CI
after PLAN-SPAR converges; do not start a lane before its `vtid:` is set in `lanes/<id>.md`. All commands run from
`apps/mobile/` unless noted; `assertNotProduction()` and the no-production-profile rule make every command offline.
**This is an all-WRITE cluster (requirements R5): every save/toggle/submit/connect/delete test uses a MOCKED gateway
and asserts the built request — it never fires a real write on any host.** No lane extracts anything into
`@vitana/core` (design §4 decision 2); if a genuinely new class-A helper is needed, that is a plan change, not a
silent scope widening, and a class-B hook is NEVER moved into core.
<!-- lane: profile -->
## Lane `profile` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (2 ledger rows → 2 route files): `PROFILE.ME /me/profile`, `PROFILE.PRIVACY /profile/me/privacy`. The public
`/u/:identifier` rows and `/profile/:id` moved to lane `public-profile` (plan decision 1b); this section governs where
the lane file still names them. depends_on: none. Web sources `src/pages/EditProfilePage.tsx` (739 lines, route
`src/App.tsx:1483-1487`), `src/pages/PublicProfilePage.tsx` (413 lines, route `src/App.tsx:1493`),
`src/pages/PrivacySettings.tsx` (301 lines, route `src/App.tsx:1501-1505`), `LegacyProfileRedirect`
(`src/App.tsx:1482`).
- [ ] 1. Native "my profile" screen `apps/mobile/app/(app)/me/profile.tsx` +
  `apps/mobile/src/screens/profile/MyProfileScreen.tsx`: mobile-web twin of `EditProfilePage.tsx` — a `ScrollView`
  of `VCard` sections (about, identity, visibility, services/showcase, galleries, progress card, share) where each
  editable section opens a native bottom-sheet twin of the matching web drawer
  (`src/components/profile/drawers/*`, `editor/*`). Data fetching re-implemented natively (native Supabase client +
  auth context — design §4 decision 2); avatar/cover/gallery upload ports wired via `expo-image-picker`, the save
  path mocked in tests (no real write). Mobile-web branch only.
  Files: `apps/mobile/app/(app)/me/profile.tsx`, `apps/mobile/src/screens/profile/**`.
  Verify: `npm test` (the profile unit tests below) + `npm run typecheck` green.
- [ ] 2. Privacy: `apps/mobile/app/(app)/profile/me/privacy.tsx` + `src/screens/profile/PrivacyScreen.tsx` (twin of
  `PrivacySettings.tsx` — visibility toggles are writes, mocked in tests). (Public profile and the legacy redirect
  are lane `public-profile`.)
  Files: `apps/mobile/app/(app)/profile/me/privacy.tsx`, `apps/mobile/src/screens/profile/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. i18n + RTL: user-visible strings from the web shards (`screens.*` keys these screens already use); any
  genuinely new key added to `src/i18n/de/profileNative.json` first, then the other ten (ar de en es fr pl pt ru sr
  tr zh); render under `ar` with start/end only; no hardcoded text, no physical `left`/`right`.
  Files: `src/i18n/*/profileNative.json` (DE first), `apps/mobile/src/screens/profile/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 4. Unit tests (fake gateway / fixtures, no network): my-profile loaded / empty / error; a section drawer
  opens and its save **builds the right request against a mocked gateway and fires nothing**; privacy toggles build
  the right request (mocked). React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/tests/profile/**`, `apps/mobile/src/screens/profile/__tests__/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 5. Flip the lane's parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync` (status
  edited by hand to `native` for the 2 rows), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (profile rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 6. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity on the **isolated G1 environment
  only** (write-heavy cluster — never a live backend as the test account): Maestro journey(s)
  `apps/mobile/maestro/profile/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes, screenshot
  parity vs the 390×844 **read-only** staging `/me/profile`, `/profile/me/privacy`. Blocked until
  G1 (and macOS minutes / G3 for iOS on a device).
  Files: `apps/mobile/maestro/profile/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 7. PR: branch `kiro/native-wave2-profile-settings-r2/profile`, title
  `VTID-xxxxx (native-wave2-profile-settings-r2/profile): native profile / privacy port`, body names
  the Kiro session id, Summary / Decisions taken / Tests / Handoff. Commit trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-profile-settings-r2/profile`. Lane → `in-review`, `next_actor: kiro` (reviewer seat
  `hotmail`). Never merge, deploy or write to a live system (protocol §7a).
<!-- lane: public-profile -->
## Lane `public-profile` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (3 ledger rows → 2 route files): `PROFILE.PUBLIC /u/:identifier`,
`PROFILE.WITH_MATCH /u/:identifier?match_intent=:intent_id`, and the legacy exclusion `/profile/:id`. depends_on:
none. Web sources `src/pages/PublicProfilePage.tsx` (413 lines, route `src/App.tsx:1493`, no `AuthGuard`, renders in
`AppLayout`), `LegacyProfileRedirect` (`src/App.tsx:1482`, no `AuthGuard`). Plan decision 1b.
- [ ] 1. Public profile `apps/mobile/app/(public)/u/[identifier].tsx` +
  `apps/mobile/src/screens/public-profile/PublicProfileScreen.tsx`: read-only twin of `PublicProfilePage.tsx`, incl.
  the `?match_intent=` highlight, in the `(public)` group (never `(app)/`). It wraps itself in `MobileAppShell` when a
  session exists and in `PublicShell` when not (the split `(app)/_layout.tsx` makes through `AuthGate`).
  Files: `apps/mobile/app/(public)/u/[identifier].tsx`, `apps/mobile/src/screens/public-profile/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. Legacy redirect `apps/mobile/app/(public)/profile/[id].tsx`: twin of `LegacyProfileRedirect` — resolve the
  id and navigate to the canonical `/u/…` profile, signed in or out, so the exclusion row goes `native`.
  Files: `apps/mobile/app/(public)/profile/[id].tsx`, `apps/mobile/src/screens/public-profile/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. i18n + RTL (as profile task 3); reuse the web's `screens.*` keys; any new key DE-first in
  `src/i18n/de/publicProfileNative.json`, then the other ten.
  Files: `src/i18n/*/publicProfileNative.json` (DE first), `apps/mobile/src/screens/public-profile/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 4. Unit tests (fake gateway / fixtures, no network): public profile loaded / not-found, `?match_intent=`
  highlight; **renders signed out (PublicShell) and signed in (MobileAppShell)**; legacy `/profile/:id` resolves and
  navigates signed out and signed in. React 19 `ReactElement`.
  Files: `apps/mobile/tests/public-profile/**`, `apps/mobile/src/screens/public-profile/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 5. Flip the lane's 3 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (these rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 6. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/public-profile/*.yaml` +
  sim/emulator screenshots + parity vs the 390×844 read-only staging `/u/:identifier`, signed out and signed in.
  Blocked until G1.
  Files: `apps/mobile/maestro/public-profile/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 7. PR: branch `kiro/native-wave2-profile-settings-r2/public-profile`, title
  `VTID-xxxxx (native-wave2-profile-settings-r2/public-profile): native public profile + legacy redirect port`;
  trailers `Collab-Session`, `Collab-Lane: native-wave2-profile-settings-r2/public-profile`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.
<!-- lane: settings -->
## Lane `settings` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (17 ledger rows → 4 route files; `/delete-account` moved to lane `delete-account`, plan decision 1a — this
section governs where the lane file still names it): `SETTINGS.OVERVIEW /settings` + the 13 `?mode=` section rows
(`NOTIFICATIONS`, `PRIVACY` +`.visibility`/`.data`/`.security`, `PREFERENCES` +`.appearance`/`.language`, `BILLING`
+`.plan`/`.payment`/`.invoices`/`.creator`), `SETTINGS.PREFERENCES_ACCESSIBILITY /settings/preferences?section=`,
`SETTINGS.LIMITATIONS /settings/limitations`, `SETTINGS.TENANT_ROLE /settings/tenant-role`. depends_on: none. Web sources `src/pages/MobileSettings.tsx` (603 lines; `VALID_SECTIONS`
`:39-44`; router `src/App.tsx:689-692`, sections `:1414-1467`), `src/pages/settings/Limitations.tsx` (491),
`src/pages/settings/TenantRole.tsx` (388).
- [ ] 1. Unified settings screen `apps/mobile/app/(app)/settings/index.tsx` +
  `apps/mobile/src/screens/settings/SettingsScreen.tsx`: mobile-web twin of `MobileSettings.tsx` — read the `mode`
  search param, render the matching section with the same `switch` the web uses (`VALID_SECTIONS`:
  notifications; privacy / .visibility / .data / .security; preferences / .appearance / .language; billing / .plan /
  .payment / .invoices / .creator), through a `MobileModePill`-style selector. Toggles/actions (notification prefs,
  privacy, preferences, billing) re-implemented natively, mocked in tests (no real write). All 14 `/settings` rows
  (`SETTINGS.OVERVIEW` + 13 `?mode=` variants) are this one file.
  Files: `apps/mobile/app/(app)/settings/index.tsx`, `apps/mobile/src/screens/settings/**`.
  Verify: `npm test` (per-mode section tests) + `npm run typecheck` green.
- [ ] 2. Standalone settings sub-screens: `apps/mobile/app/(app)/settings/preferences.tsx` (the
  `/settings/preferences?section=` route — reproduce the current mobile-web fallback for the non-`VALID_SECTIONS`
  `accessibility` param, requirements R1.5; invent no new section), `apps/mobile/app/(app)/settings/limitations.tsx`
  (twin of `Limitations.tsx`), `apps/mobile/app/(app)/settings/tenant-role.tsx` (twin of `TenantRole.tsx`, the role
  switcher) + `src/screens/settings/*`.
  Files: `apps/mobile/app/(app)/settings/preferences.tsx`, `apps/mobile/app/(app)/settings/limitations.tsx`,
  `apps/mobile/app/(app)/settings/tenant-role.tsx`, `apps/mobile/src/screens/settings/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. (moved: account deletion is lane `delete-account`, below; no `apps/mobile/app/(app)/delete-account.tsx`.)
- [ ] 4. i18n + RTL (as profile task 3) across all settings screens; new keys DE-first
  (`src/i18n/de/settingsNative.json`) then the other ten; reuse the existing `screens.mobilesettings.*` keys.
  Files: `src/i18n/*/settingsNative.json` (DE first), `apps/mobile/src/screens/settings/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / fixtures, no network): each `?mode=` section renders (13 modes); a toggle/action
  per section **builds the right request against a mocked gateway and fires nothing**; preferences `?section=`
  fallback; limitations + tenant-role loaded / empty / error. React 19 `ReactElement`.
  Files: `apps/mobile/tests/settings/**`, `apps/mobile/src/screens/settings/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the 17 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (settings rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity on the **isolated G1 environment
  only**: Maestro `apps/mobile/maestro/settings/*.yaml` + sim/emulator screenshots + parity vs the 390×844 read-only
  staging `/settings` (each mode), `/settings/limitations`, `/settings/tenant-role`. Blocked until
  G1 (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/settings/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 8. PR: branch `kiro/native-wave2-profile-settings-r2/settings`, title
  `VTID-xxxxx (native-wave2-profile-settings-r2/settings): native settings / limitations / tenant-role
  port`; trailers `Collab-Session`, `Collab-Lane: native-wave2-profile-settings-r2/settings`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.
<!-- lane: delete-account -->
## Lane `delete-account` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (1 ledger row → 1 route file): the exclusion `/delete-account`. depends_on: none. Web source
`src/pages/legal/DeleteAccount.tsx` (route `src/App.tsx:847`, "Public Routes - No Auth Required", no `AuthGuard`).
Plan decision 1a.
- [ ] 1. Account deletion `apps/mobile/app/(public)/delete-account.tsx` +
  `apps/mobile/src/screens/delete-account/DeleteAccountScreen.tsx`: twin of `DeleteAccount.tsx` in the `(public)` group
  (no `AuthGate`), never under `app/(app)/`. It reads the session itself: signed out → the web's signed-out view,
  signed in → the info → confirm (typed check) → dialog flow. The delete request is **built and asserted against a
  mocked gateway, never fired** (destructive write, requirements R5.1/R5.2).
  Files: `apps/mobile/app/(public)/delete-account.tsx`, `apps/mobile/src/screens/delete-account/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. i18n + RTL (as profile task 3); new keys DE-first (`src/i18n/de/deleteAccountNative.json`) then the other
  ten; reuse the existing `screens.legal.*` keys.
  Files: `src/i18n/*/deleteAccountNative.json` (DE first), `apps/mobile/src/screens/delete-account/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 3. Unit tests (fake gateway / fixtures, no network): **renders signed out (no session) and signed in**; the
  confirm step builds the delete request against a mocked gateway and fires nothing. React 19 `ReactElement`.
  Files: `apps/mobile/tests/delete-account/**`, `apps/mobile/src/screens/delete-account/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 4. Flip the `/delete-account` parity row to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (that row only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 5. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/delete-account/*.yaml` +
  sim/emulator screenshots + parity vs the 390×844 read-only staging `/delete-account` (never confirmed). Blocked
  until G1.
  Files: `apps/mobile/maestro/delete-account/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 6. PR: branch `kiro/native-wave2-profile-settings-r2/delete-account`, title
  `VTID-xxxxx (native-wave2-profile-settings-r2/delete-account): native public delete-account port`; trailers
  `Collab-Session`, `Collab-Lane: native-wave2-profile-settings-r2/delete-account`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.
<!-- lane: support-connectors -->
## Lane `support-connectors` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (14 ledger rows → 3 route files): `SETTINGS.SUPPORT /support` + `SUPPORT_CONTACT` / `SUPPORT_COMMUNITY` /
`SUPPORT_FAQ` (`?tab=`), the 8 `CONNECTORS.* /connectors?tab=…` + `SETTINGS.SOCIAL /connectors`, and
`SETTINGS.CONNECTED_APPS /settings/connected-apps`. depends_on: none. Web sources mobile support
`src/pages/MobileSupport.tsx` (819 lines; tabs `:43-98`; router `src/App.tsx:715-718`), connectors
`src/pages/settings/ConnectedApps.tsx` (2111 lines; `activeTab` `:105,2180`; route `src/App.tsx:1441-1445`).
Member-facing only — admin partner-connections and Commerce connector docs are out (requirements R0.5).
- [ ] 1. Support screen `apps/mobile/app/(app)/support.tsx` + `apps/mobile/src/screens/support/SupportScreen.tsx`:
  mobile-web twin of `MobileSupport.tsx` — read the `tab` param (contact / tickets / faqs / community), render the
  matching tab; the Contact/report form builds the `POST /api/v1/feedback/tickets` request (via a native twin of
  `buildSupportContactBody`) and asserts it against a **mocked gateway, firing nothing** (write, requirements R5.2);
  My Tickets list (read), FAQ accordion, community tab; ORB support-report entry wired via a port. All 4 `/support`
  rows are this one file.
  Files: `apps/mobile/app/(app)/support.tsx`, `apps/mobile/src/screens/support/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. Connectors screen `apps/mobile/app/(app)/connectors.tsx` + `src/screens/support/ConnectorsScreen.tsx`:
  mobile-web twin of `ConnectedApps.tsx` — read the `tab`/category param (agent / ai / fitness / health / media /
  other / productivity / social, `APP_ORDER`) plus the connected view; connect/disconnect actions build the right
  request against a **mocked gateway (no real write)**; per-provider health cards via a native twin of
  `useWearableProviders`. Serves the 8 `CONNECTORS.*` rows + `SETTINGS.SOCIAL /connectors`. Then
  `apps/mobile/app/(app)/settings/connected-apps.tsx` for the `SETTINGS.CONNECTED_APPS` row: mirror the web redirect
  `/settings/connected-apps`→`/connectors` (render the connectors screen or navigate), so the row goes `native`
  (design §1a/§2c).
  Files: `apps/mobile/app/(app)/connectors.tsx`, `apps/mobile/app/(app)/settings/connected-apps.tsx`,
  `apps/mobile/src/screens/support/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. i18n + RTL (as profile task 3) across support + connectors screens; new keys DE-first
  (`src/i18n/de/supportNative.json`) then the other ten; reuse existing `screens.mobilesupport.*` /
  connected-apps keys.
  Files: `src/i18n/*/supportNative.json` (DE first), `apps/mobile/src/screens/support/**`.
  Verify: `npm run typecheck`; `npm test` no-raw-text / no-physical-direction tests pass.
- [ ] 4. Unit tests (fake gateway / fixtures, no network): support each `?tab=` renders; Contact submit **builds the
  feedback-ticket request against a mocked gateway and fires nothing**; My Tickets loaded / empty; FAQ expand;
  connectors each category renders (8 tabs + connected); connect/disconnect builds the right request (mocked);
  `/settings/connected-apps` resolves to the connectors screen. React 19 `ReactElement`.
  Files: `apps/mobile/tests/support/**`, `apps/mobile/src/screens/support/__tests__/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 5. Flip the 14 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (support-connectors rows only),
  `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 6. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity on the **isolated G1 environment
  only**: Maestro `apps/mobile/maestro/support/*.yaml` + sim/emulator screenshots + parity vs the 390×844 read-only
  staging `/support` (each tab) and `/connectors` (each category). Blocked until G1 (+ macOS/G3 for iOS).
  Files: `apps/mobile/maestro/support/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 7. PR: branch `kiro/native-wave2-profile-settings-r2/support-connectors`, title
  `VTID-xxxxx (native-wave2-profile-settings-r2/support-connectors): native support / connectors port`; trailers
  `Collab-Session`, `Collab-Lane: native-wave2-profile-settings-r2/support-connectors`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.
## Acceptance (every lane; the reviewer seat checks these)
- Requirements R1–R6 met for the lane's screens; mobile-web parity, N2/N3 composition, `@vitana/core`-only bridge
  (no core extraction — design §4 decision 2; data hooks re-implemented natively).
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native` (query variants satisfied by the base-shape route file).
- 11 locales, DE-first new keys, RTL covered; no hardcoded user-visible text; no physical `left`/`right`.
- **All-write cluster:** every save/toggle/submit/connect/delete test uses a mocked gateway and asserts the built
  request; no test fires a real write on any host (requirements R5).
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- Device-runtime parity (the last G1 task per lane) is deferred to G1 as `next_actor: owner`; it is not a merge
  blocker for the port, it is recorded in the lane log and `staging-tests.json`, and at G1 it runs only on the
  isolated test environment.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).
