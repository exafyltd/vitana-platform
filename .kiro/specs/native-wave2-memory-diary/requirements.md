# Requirements — Native Wave 2: Memory / Diary screen ports (native-wave2-memory-diary)

Wave 2 screen-port batch of the Maxina native app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`, program
VTID-05021). Port the memory and daily-diary screens that the parity ledger assigns to the `memory-diary` lane to the
native app (`apps/mobile/`) at 1:1 parity with today's **mobile web** screens, built on `@vitana/core` +
`@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime
verification on a device needs the isolated test environment G1 and is called out per task as `depends-on-owner`.

Measured against vitana-v1 `origin/main`, parity ledger `apps/mobile/parity/ledger.json` version 2:
**7 rows carry `"lane": "memory-diary"`, every one `status: "not_started"`** (all `kind: screen`, `scope: in`,
`source: registry`, `exception: null`, `owner: null`; 435 rows total). Verified by reading the committed ledger at
`origin/main` (`git show origin/main:apps/mobile/parity/ledger.json`). The two lanes below partition those 7 rows
with **disjoint `paths`**. The read-only ledger investigation is `sparring/ledger-findings.md`.

Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §4 (parity method), §6 (verification &
safety), the N2 README web→native prop map (`apps/mobile/README.md` "Web → native prop map"), and the Spotlight /
design rules via tokens. No new web screen, no `App.tsx` route, no `screens.json` / `exclusions.json` entry is added
by this plan (ports only), so no `screen-manifest` or voice-registry change and no new native parity row — only
status flips on existing rows.

## R0 — Scope and the two lanes

0.1 The plan ports exactly the 7 web destinations the parity ledger lists under `"lane": "memory-diary"`, split into
two disjoint lanes by cluster. No row is in two lanes; no row in scope is left without a lane.

0.2 Lane **`memory`** — the Memory overview and its sub-screens:
`MEMORY.OVERVIEW /memory` (web `src/pages/Memory.tsx`, 124 lines; route `src/App.tsx:1605`),
`MEMORY.TIMELINE /memory/timeline` (web `src/pages/memory/Timeline.tsx`, 66 lines; route `src/App.tsx:1610`),
`MEMORY.RECALL /memory/recall` (web `src/pages/memory/Recall.tsx`, 350 lines; route `src/App.tsx:1620`),
`MEMORY.PERMISSIONS /memory/permissions` (web `src/pages/memory/Permissions.tsx`, 62 lines; route
`src/App.tsx:1625`). Recall's body is static mock data + an honest empty state (`SpotlightEmpty`) — it ports as a
pure presentational screen (ledger-findings §2).

0.3 Lane **`diary`** — the Daily Diary screen in its two modes:
`MEMORY.DAILY_DIARY /daily-diary`, `MEMORY.DIARY /daily-diary?tab=health`, `MEMORY.DIARY_BUGS /daily-diary?tab=bugs`
(web `src/pages/MobileDailyDiary.tsx`, 193 lines; route `src/App.tsx:1120`). All three rows resolve to the SAME web
page component; `?tab=health`/`?tab=bugs` only pick the `MobileModePill` mode (`searchParams.get("tab")`, default
`health`). The native port is **one route** reading the `tab` query param — the three rows flip to `native` together.

0.4 The desktop diary hub `src/pages/memory/Diary.tsx` (381 lines, route `src/App.tsx:1615` `/memory/diary`) is NOT a
cluster row: on mobile `/memory/diary` redirects to `/daily-diary` (`src/App.tsx:720-727`). For the native (phone)
app only the `MobileDailyDiary` path matters.

## R1 — 1:1 parity with the mobile web screen

1.1 Each native screen mirrors the **mobile web** branch (the `useIsMobile()` ≤ 1024 px branch,
`src/hooks/use-mobile.tsx`) of its web source — same layout, same sections, same navigation, same wording. No
redesign, no added or removed section, no reordering (program §4 "Allowed native improvements only": platform
transitions, gestures, keyboard avoidance, safe areas, haptics, system sheets — nothing else).

1.2 Screens compose through the N3 shell and the N2 UI kit only: `MobileAppShell`, `TopAppBar`, `BottomNav`,
`MobileModePill`, bottom sheets, `VCard`, etc. come from `src/ports/*` (`apps/mobile/README.md` "Ports"); no web
component, no raw colour, every visual value from `@vitana/tokens`.

1.3 Web→native translation follows the README map exactly (`onClick`→`onPress`, `className`→`style`,
`toast`→`@vitana/ui/sonner`, documented `Select`/`Tooltip`/close-button/`Slider`/`Progress` differences). The four
web defects the N2 README lists (slider range thumb, progress RTL fill, inert `shouldScaleBackground`, close-button
RTL side) are **not** reproduced — the native kit's corrected behaviour is used, and no web file is touched.

1.4 Business logic, query keys, hooks, types are consumed through `@vitana/core` where a module is class-A. **The
cluster's runtime data paths are all class-B** (ledger-findings §3: they import `@/lib/community-gateway` via
`memory-api`/`memory-learning-api`/`timeline-api`/`diary-index-sync`, or `@/integrations/supabase/client`) — these
are **re-implemented natively** against the native gateway helper in `apps/mobile/src/auth/gateway.ts`
(`getGateway()`/`gatewayGet()`, wrapping `@vitana/core/gateway`'s `createGatewayFetch`/`gatewayJson`) and the native
Supabase client reached through the `core` port (`@vitana/core/supabase` → `apps/mobile/src/auth/client.ts`) — never
a direct `@supabase/supabase-js` import in screen code (design §2 ports-only rule) — NOT core-extracted. A web module a lane needs that
IS genuinely pure (class-A) and not yet re-exported is added to `packages/core/manifest.json` with a re-export in the
same lane PR and `node scripts/native/core-closure.mjs --write` run (program §3). `@vitana/core` is the only
web→native bridge; ESLint bans `@/` and relative paths into the web `src/` from app code. Pure presentation helpers
that pull web-only deps (`timeline-meta.tsx`, `routine-text.ts`) are **mirrored** natively, not re-exported.

1.5 Diary capture is re-implemented with native deps: photo upload → `expo-image-picker` (upload to Supabase
Storage, as on web); audio capture → a native expo audio recorder (`expo-audio`/`expo-av`) + native/back-end STT (web
uses MediaRecorder + Web Speech / backend STT). These new native deps are added to `apps/mobile/package.json` in the
`diary` lane PR, with the camera / photo-library / microphone permission strings added to the app's Expo config
`apps/mobile/app.config.ts` (the app uses `app.config.ts`, there is no `app.json`); both paths are in the `diary`
lane's `paths` allow-list and are listed in its `scope.json` (ledger-findings §3).

## R2 — i18n (11 locales) + RTL

2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog
shards `src/i18n/<locale>/*.json`, read through the generated catalog map — no hardcoded text (repo i18n hard rule;
`apps/mobile/README.md` "i18n"). Most strings already exist under `screens.memory.*`, `timeline.*`,
`memoryLearning.*`, `diary.*`, `spotlightMember.memory.*` (ledger-findings §5).

2.2 All 11 active locales resolve: **ar de en es fr pl pt ru sr tr zh** (program §1 design-system note; the live
`supported_locales` table has all 11 `status='ga'`). A new key is added to the **German shard first**
(`src/i18n/de/<screen>Native.json`) then mirrored to the other ten; DE is du-form; **pt is Brazilian Portuguese
você-form**.

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
and NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route in `apps/mobile/app/`,
and no route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`). The 3 diary rows flip together
(one route for the `tab` variants).

4.2 No lane changes `scope`/`lane` of a row (those come from `scripts/native/parity-scope.json`); no lane edits
another lane's rows. The two lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is the one
shared path and conflicts resolve by row.

## R5 — Verification and safety (never production)

5.1 Never test against production; staging specs are read-only (program §6; root `CLAUDE.md`). The native app has
**no production profile** and `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the production
Supabase project and the staging hosts (`apps/mobile/README.md` "No production host, ever").

5.2 Build-time verification per lane is offline: `npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with a
**fake gateway / fixtures**, no network — the diary photo picker / audio recorder are faked), `APP_PROFILE=development
npm run bundle` (Metro + Hermes JS for iOS and Android), and `APP_PROFILE=development EXPO_OFFLINE=1 npm run
deps:check` — all from `apps/mobile/`; plus `node scripts/native/parity-ledger.mjs --check` and
`node scripts/native/core-closure.mjs --check` from the repo root. No live call is made.

5.3 Runtime parity verification (simulator / emulator screenshots, Maestro device journeys, screenshot parity vs the
390×844 web screen; for `diary` the live camera/microphone capture exercise) is a **depends-on-owner (G1)** step: it
needs the isolated test environment (and macOS minutes / G3 for iOS on a device). Each such task is marked
`next_actor: owner` in `tasks.md` and the lane records G1 as a blocker in its log; it does not block the build-time
port landing.

5.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by CI
after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET except
sign-in; never `vitanaland.com`. No diary write (text/photo/audio entry, ticket) is ever exercised against a live
system — those paths are proven by offline unit tests only (root `CLAUDE.md` absolute rule; community/diary content
reaches real feeds).

5.5 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New rule).

## R6 — Done

6.1 Every in-scope ledger row for the lane is `native` with its native route in `apps/mobile/app/` and its
functional-parity checklist (program §4 per-screen checklist) recorded; RTL (`ar`) covered.

6.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check`, `parity-ledger --check` and
`core-closure --check` green; NATIVE-CI (incl. the shell source-pin and ports checks) and the Collab handoff + Lane
scope PR-GATE checks green.

6.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only spec)
and `plan-sparring.md` (copy of this plan's sparring record).

## Out of scope (named so a lane does not drift into them)

- Any screen in another Wave 2 ledger lane (`home-feed`, `events-calendar`, `media`, `ai`, `discover-commerce`,
  `inbox-chat-calls`, etc.) — each is its own plan.
- The desktop diary hub `src/pages/memory/Diary.tsx` (`/memory/diary`) — not a cluster row; mobile redirects it to
  `/daily-diary`.
- `/autopilot/audiobook` and any other `audio`/`recall`/`timeline` destination outside the `memory-diary` lane.
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module — their own plans / owner gates.
- Any backend / gateway / migration change. The cluster consumes the existing memory/timeline/diary gateway endpoints
  unchanged.
- Any web-side change beyond adding an i18n key (DE first, then mirrors) and — only if a genuinely pure class-A
  module is found — a `@vitana/core` re-export line.
